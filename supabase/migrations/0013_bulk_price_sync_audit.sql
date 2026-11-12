-- Evita timeout na sincronizacao de precos: compara e grava alteracoes em lote.

begin;

alter function public.import_catalog_batch(text,text,jsonb)
rename to import_catalog_batch_legacy;

create or replace function public.audit_catalog_price_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sync_key uuid := public.current_catalog_sync_id();
  code_value text;
  table_code text;
  previous_price numeric;
begin
  if current_setting('debaportal.bulk_price_audit', true) = 'on' then return new; end if;
  if sync_key is null then return new; end if;
  select p.code into code_value from public.products p where p.id = new.product_id;
  select pt.code into table_code from public.price_tables pt where pt.id = new.price_table_id;
  select pp.price into previous_price
  from public.product_prices pp
  where pp.product_id = new.product_id
    and pp.price_table_id = new.price_table_id
    and pp.id <> new.id
  order by pp.valid_from desc
  limit 1;
  if previous_price is distinct from new.price then
    perform public.record_catalog_change(sync_key, code_value, 'PRECO', 'Preço', table_code,
      previous_price::text, new.price::text);
  end if;
  return new;
end;
$$;

create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind;
  version_key uuid;
  sync_key uuid;
  run_key_value text := case when source_name like 'onedrive:%' then source_name else gen_random_uuid()::text end;
  is_onedrive boolean := source_name like 'onedrive:%';
  applied integer := 0;
  price_snapshot_at timestamptz;
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

    insert into public.sync_item_changes(
      sync_id,product_code,change_scope,field_name,context_label,previous_value,new_value
    )
    select sync_key, incoming_rows.code, 'PRECO', 'Preço', incoming_rows.table_code,
      current_price.price::text, incoming_rows.new_price::text
    from (
      select trim(incoming.value->>'code') as code,
        product.id as product_id,
        selected_table.id as price_table_id,
        selected_table.code as table_code,
        (incoming.value->>'price')::numeric as new_price
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
      ) selected_table on true
    ) incoming_rows
    left join public.product_prices current_price
      on current_price.product_id = incoming_rows.product_id
      and current_price.price_table_id = incoming_rows.price_table_id
      and current_price.valid_to is null
    where current_price.price is distinct from incoming_rows.new_price;

    if is_onedrive then
      price_snapshot_at := clock_timestamp();
      update public.product_prices price
      set valid_to = price_snapshot_at
      where price.valid_to is null
        and price.price_table_id in (
          select table_row.id from public.price_tables table_row
          where table_row.code in ('PR-PR','SP-SP','PR-SC','PR-SP')
        );
    else
      update public.product_prices price
      set valid_to = clock_timestamp()
      from (
        select distinct product.id as product_id, selected_table.id as price_table_id
        from jsonb_array_elements(rows) incoming
        join public.products product on product.code = trim(incoming.value->>'code')
        join lateral (
          select table_row.id
          from public.price_tables table_row
          where table_row.active and (
            table_row.id::text = incoming.value->>'price_table_id'
            or table_row.code = incoming.value->>'price_table_code'
          )
          order by table_row.version desc
          limit 1
        ) selected_table on true
      ) incoming_rows
      where price.product_id = incoming_rows.product_id
        and price.price_table_id = incoming_rows.price_table_id
        and price.valid_to is null;
    end if;

    insert into public.product_prices(product_id,price_table_id,price,commercial_version_id)
    select product.id, selected_table.id, (incoming.value->>'price')::numeric, version_key
    from jsonb_array_elements(rows) incoming
    join public.products product on product.code = trim(incoming.value->>'code')
    join lateral (
      select table_row.id
      from public.price_tables table_row
      where table_row.active and (
        table_row.id::text = incoming.value->>'price_table_id'
        or table_row.code = incoming.value->>'price_table_code'
      )
      order by table_row.version desc
      limit 1
    ) selected_table on true;
    applied := jsonb_array_length(rows);

    if is_onedrive then
      insert into public.sync_item_changes(sync_id,product_code,change_scope,field_name,context_label,previous_value,new_value)
      select sync_key, product.code, 'PRECO', 'Preço', price_table.code, price.price::text, null
      from public.product_prices price
      join public.products product on product.id = price.product_id
      join public.price_tables price_table on price_table.id = price.price_table_id
      where price.valid_to = price_snapshot_at
        and not exists (
          select 1 from jsonb_array_elements(rows) incoming
          where trim(incoming.value->>'code') = product.code
            and (incoming.value->>'price_table_id' = price_table.id::text or incoming.value->>'price_table_code' = price_table.code)
        );
    end if;

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

revoke all on function public.import_catalog_batch_legacy(text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.audit_catalog_price_change() from public,anon,authenticated;
revoke all on function public.import_catalog_batch(text,text,jsonb) from public,anon;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated,service_role;

commit;
