-- Processa o snapshot de precos a partir de uma tabela temporaria para evitar
-- releituras quadraticas do JSON e manter a auditoria dentro do timeout da API.

begin;

create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind;
  version_key uuid;
  sync_key uuid;
  run_key_value text := case when source_name like 'onedrive:%' then source_name else gen_random_uuid()::text end;
  is_onedrive boolean := source_name like 'onedrive:%';
  applied integer := 0;
  invalid_code text;
  invalid_table text;
begin
  if import_kind_value <> 'PRECOS' then
    return public.import_catalog_batch_legacy(import_kind, source_name, rows);
  end if;
  if not public.is_admin() then raise exception 'Apenas administradores podem importar'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then raise exception 'Lote vazio'; end if;

  insert into public.catalog_versions(kind,label,source_name,row_count,is_active,created_by)
  values(import_kind_value,import_kind_value::text || ' ' || to_char(now(),'YYYY-MM-DD HH24:MI'),source_name,jsonb_array_length(rows),false,auth.uid())
  returning id into version_key;
  insert into public.sync_metadata(source_kind,import_kind,source_name,run_key,rows_received,version_id,started_by)
  values(case when is_onedrive then 'ONEDRIVE' else 'MANUAL' end,import_kind_value,source_name,run_key_value,jsonb_array_length(rows),version_key,auth.uid())
  returning id into sync_key;
  perform set_config('debaportal.sync_id', sync_key::text, true);
  perform set_config('debaportal.bulk_price_audit', 'on', true);

  begin
    select incoming.value->>'code' into invalid_code
    from jsonb_array_elements(rows) incoming
    left join public.products product on product.code = trim(incoming.value->>'code')
    where nullif(trim(incoming.value->>'code'), '') is null
      or not (incoming.value ? 'price')
      or product.id is null
    limit 1;
    if invalid_code is not null or exists (
      select 1 from jsonb_array_elements(rows) incoming
      where nullif(trim(incoming.value->>'code'), '') is null or not (incoming.value ? 'price')
    ) then
      raise exception 'Produto ou preco invalido no lote: %', coalesce(invalid_code, 'sem codigo');
    end if;

    select coalesce(incoming.value->>'price_table_code', incoming.value->>'price_table_id', 'sem tabela') into invalid_table
    from jsonb_array_elements(rows) incoming
    left join lateral (
      select table_row.id
      from public.price_tables table_row
      where table_row.active and (
        table_row.id::text = incoming.value->>'price_table_id'
        or table_row.code = incoming.value->>'price_table_code'
      )
      order by table_row.version desc
      limit 1
    ) selected_table on true
    where selected_table.id is null
    limit 1;
    if invalid_table is not null or exists (
      select 1 from jsonb_array_elements(rows) incoming
      where nullif(incoming.value->>'price_table_id','') is null
        and nullif(incoming.value->>'price_table_code','') is null
    ) then
      raise exception 'Tabela de preco nao encontrada: %', coalesce(invalid_table, 'sem tabela');
    end if;

    create temporary table debaportal_price_import (
      product_id uuid not null,
      product_code text not null,
      price_table_id uuid not null,
      table_code text not null,
      new_price numeric(14,2) not null
    ) on commit drop;

    insert into pg_temp.debaportal_price_import(product_id,product_code,price_table_id,table_code,new_price)
    select product.id, product.code, selected_table.id, selected_table.code,
      (incoming.value->>'price')::numeric
    from jsonb_array_elements(rows) incoming
    join public.products product on product.code = trim(incoming.value->>'code')
    join lateral (
      select table_row.id, table_row.code
      from public.price_tables table_row
      where table_row.active and (
        table_row.id::text = incoming.value->>'price_table_id'
        or table_row.code = incoming.value->>'price_table_code'
      )
      order by table_row.version desc
      limit 1
    ) selected_table on true;

    create index debaportal_price_import_key_idx
      on pg_temp.debaportal_price_import(product_id, price_table_id);
    analyze pg_temp.debaportal_price_import;

    if (select count(*) from pg_temp.debaportal_price_import) <> jsonb_array_length(rows) then
      raise exception 'Nem todos os precos puderam ser preparados para importacao';
    end if;

    insert into public.sync_item_changes(
      sync_id,product_code,change_scope,field_name,context_label,previous_value,new_value
    )
    select sync_key, staged.product_code, 'PRECO', 'Preço', staged.table_code,
      current_price.price::text, staged.new_price::text
    from pg_temp.debaportal_price_import staged
    left join public.product_prices current_price
      on current_price.product_id = staged.product_id
      and current_price.price_table_id = staged.price_table_id
      and current_price.valid_to is null
    where current_price.price is distinct from staged.new_price;

    if is_onedrive then
      insert into public.sync_item_changes(
        sync_id,product_code,change_scope,field_name,context_label,previous_value,new_value
      )
      select sync_key, product.code, 'PRECO', 'Preço', price_table.code,
        current_price.price::text, null
      from public.product_prices current_price
      join public.products product on product.id = current_price.product_id
      join public.price_tables price_table on price_table.id = current_price.price_table_id
      left join pg_temp.debaportal_price_import staged
        on staged.product_id = current_price.product_id
        and staged.price_table_id = current_price.price_table_id
      where current_price.valid_to is null
        and price_table.code in ('PR-PR','SP-SP','PR-SC','PR-SP')
        and staged.product_id is null;

      update public.product_prices current_price
      set valid_to = clock_timestamp()
      from public.price_tables price_table
      where current_price.valid_to is null
        and price_table.id = current_price.price_table_id
        and price_table.code in ('PR-PR','SP-SP','PR-SC','PR-SP');
    else
      update public.product_prices current_price
      set valid_to = clock_timestamp()
      from pg_temp.debaportal_price_import staged
      where current_price.product_id = staged.product_id
        and current_price.price_table_id = staged.price_table_id
        and current_price.valid_to is null;
    end if;

    insert into public.product_prices(product_id,price_table_id,price,commercial_version_id)
    select staged.product_id, staged.price_table_id, staged.new_price, version_key
    from pg_temp.debaportal_price_import staged;
    applied := jsonb_array_length(rows);

    update public.catalog_versions set is_active=false where kind=import_kind_value and id<>version_key;
    update public.catalog_versions set is_active=true where id=version_key;
    update public.sync_metadata set status='CONCLUIDO',rows_applied=applied,finished_at=now() where id=sync_key;
    perform public.prune_catalog_change_history();
    return jsonb_build_object(
      'ok',true,'version_id',version_key,'rows_applied',applied,'sync_id',sync_key,
      'changes',(select count(*) from public.sync_item_changes where sync_id=sync_key)
    );
  exception when others then
    update public.sync_metadata set status='FALHOU',error_count=1,error_message=left(sqlerrm,1000),finished_at=now() where id=sync_key;
    return jsonb_build_object('ok',false,'error',sqlerrm,'sync_id',sync_key);
  end;
end;
$$;

revoke all on function public.import_catalog_batch(text,text,jsonb) from public,anon;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated,service_role;

commit;
