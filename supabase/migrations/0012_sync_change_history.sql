-- Historico enxuto de alteracoes por sincronizacao, visivel somente para ADMIN.

begin;

alter table public.sync_metadata
add column if not exists run_key text;

update public.sync_metadata
set run_key = id::text
where run_key is null;

alter table public.sync_metadata
alter column run_key set not null;

create index if not exists sync_metadata_run_key_idx
on public.sync_metadata(run_key, started_at desc);

create table if not exists public.sync_item_changes (
  id bigint generated always as identity primary key,
  sync_id uuid not null references public.sync_metadata(id) on delete cascade,
  product_code text not null,
  change_scope text not null check (change_scope in ('PRODUTO','APLICACAO','PRECO','ESTOQUE')),
  field_name text not null,
  context_label text,
  previous_value text,
  new_value text,
  changed_at timestamptz not null default now(),
  check (previous_value is distinct from new_value)
);

create index if not exists sync_item_changes_sync_idx
on public.sync_item_changes(sync_id, changed_at desc);

create index if not exists sync_item_changes_product_idx
on public.sync_item_changes(product_code, changed_at desc);

alter table public.sync_item_changes enable row level security;

drop policy if exists sync_item_changes_admin_read on public.sync_item_changes;
create policy sync_item_changes_admin_read on public.sync_item_changes
for select using (public.is_admin());

revoke all on public.sync_item_changes from public, anon, authenticated;
grant select on public.sync_item_changes to authenticated;

create or replace function public.current_catalog_sync_id()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  setting_value text := current_setting('debaportal.sync_id', true);
begin
  if nullif(setting_value, '') is null then return null; end if;
  return setting_value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function public.record_catalog_change(
  target_sync_id uuid,
  target_product_code text,
  target_scope text,
  target_field text,
  target_context text,
  target_previous text,
  target_new text
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if target_sync_id is null or nullif(trim(target_product_code), '') is null then return; end if;
  if target_previous is not distinct from target_new then return; end if;
  insert into public.sync_item_changes(
    sync_id, product_code, change_scope, field_name, context_label, previous_value, new_value
  ) values (
    target_sync_id,
    left(trim(target_product_code), 120),
    target_scope,
    left(target_field, 120),
    nullif(left(coalesce(target_context, ''), 120), ''),
    case when target_previous is null then null else left(target_previous, 2000) end,
    case when target_new is null then null else left(target_new, 2000) end
  );
end;
$$;

create or replace function public.audit_catalog_product_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sync_key uuid := public.current_catalog_sync_id();
begin
  if sync_key is null then return new; end if;
  if tg_op = 'INSERT' then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Item', null, null, 'Incluído no catálogo');
    return new;
  end if;
  if old.description is distinct from new.description then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Descrição', null, old.description, new.description);
  end if;
  if old.category is distinct from new.category then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Categoria', null, old.category, new.category);
  end if;
  if old.product_line is distinct from new.product_line then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Marca / linha', null, old.product_line, new.product_line);
  end if;
  if old.synonyms is distinct from new.synonyms then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Sinônimos', null,
      array_to_string(old.synonyms, '; '), array_to_string(new.synonyms, '; '));
  end if;
  if old.active is distinct from new.active then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Situação no catálogo', null,
      case when old.active then 'Ativo' else 'Ausente da fonte' end,
      case when new.active then 'Ativo' else 'Ausente da fonte' end);
  end if;
  return new;
end;
$$;

drop trigger if exists products_audit_catalog_sync on public.products;
create trigger products_audit_catalog_sync
after insert or update on public.products
for each row execute function public.audit_catalog_product_change();

create or replace function public.audit_catalog_price_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sync_key uuid := public.current_catalog_sync_id();
  code_value text;
  table_code text;
  previous_price numeric;
begin
  if sync_key is null then return new; end if;
  select p.code into code_value from public.products p where p.id = new.product_id;
  select pt.code into table_code from public.price_tables pt where pt.id = new.price_table_id;
  select pp.price into previous_price
  from public.product_prices pp
  where pp.product_id = new.product_id
    and pp.price_table_id = new.price_table_id
    and pp.id <> new.id
  order by pp.valid_to desc nulls last, pp.created_at desc
  limit 1;
  if previous_price is distinct from new.price then
    perform public.record_catalog_change(sync_key, code_value, 'PRECO', 'Preço', table_code,
      previous_price::text, new.price::text);
  end if;
  return new;
end;
$$;

drop trigger if exists product_prices_audit_catalog_sync on public.product_prices;
create trigger product_prices_audit_catalog_sync
after insert on public.product_prices
for each row execute function public.audit_catalog_price_change();

create or replace function public.audit_catalog_stock_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sync_key uuid := public.current_catalog_sync_id();
  code_value text;
  branch_code text;
begin
  if sync_key is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select p.code into code_value from public.products p where p.id = coalesce(new.product_id, old.product_id);
  select b.code into branch_code from public.branches b where b.id = coalesce(new.branch_id, old.branch_id);
  if tg_op = 'INSERT' then
    perform public.record_catalog_change(sync_key, code_value, 'ESTOQUE', 'Estoque', branch_code, null, new.quantity::text);
    return new;
  elsif tg_op = 'UPDATE' then
    if old.quantity is distinct from new.quantity then
      perform public.record_catalog_change(sync_key, code_value, 'ESTOQUE', 'Estoque', branch_code,
        old.quantity::text, new.quantity::text);
    end if;
    return new;
  end if;
  perform public.record_catalog_change(sync_key, code_value, 'ESTOQUE', 'Estoque', branch_code,
    old.quantity::text, null);
  return old;
end;
$$;

drop trigger if exists branch_stock_audit_catalog_sync on public.branch_stock;
create trigger branch_stock_audit_catalog_sync
after insert or update or delete on public.branch_stock
for each row execute function public.audit_catalog_stock_change();

create or replace function public.prune_catalog_change_history()
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.sync_item_changes changes
  where not exists (
    select 1
    from public.sync_metadata metadata
    join (
      select recent.run_key
      from public.sync_metadata recent
      group by recent.run_key
      order by max(recent.started_at) desc
      limit 20
    ) kept on kept.run_key = metadata.run_key
    where metadata.id = changes.sync_id
  );
$$;

create or replace function public.admin_list_sync_runs(max_runs integer default 12)
returns table (
  run_key text,
  source_kind text,
  import_kinds text[],
  started_at timestamptz,
  finished_at timestamptz,
  status text,
  rows_received bigint,
  rows_applied bigint,
  changed_products bigint,
  changed_fields bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem consultar sincronizacoes'; end if;
  return query
  with metadata_runs as (
    select metadata.run_key,
      max(metadata.source_kind)::text as source_kind,
      array_agg(distinct metadata.import_kind::text order by metadata.import_kind::text) as import_kinds,
      min(metadata.started_at) as started_at,
      max(metadata.finished_at) as finished_at,
      case
        when bool_or(metadata.status = 'FALHOU') then 'FALHOU'
        when bool_or(metadata.status = 'EM_ANDAMENTO') then 'EM_ANDAMENTO'
        else 'CONCLUIDO'
      end as status,
      sum(metadata.rows_received)::bigint as rows_received,
      sum(metadata.rows_applied)::bigint as rows_applied
    from public.sync_metadata metadata
    group by metadata.run_key
  ), change_totals as (
    select metadata.run_key,
      count(distinct changes.product_code)::bigint as changed_products,
      count(changes.id)::bigint as changed_fields
    from public.sync_item_changes changes
    join public.sync_metadata metadata on metadata.id = changes.sync_id
    group by metadata.run_key
  )
  select runs.run_key, runs.source_kind, runs.import_kinds, runs.started_at, runs.finished_at,
    runs.status, runs.rows_received, runs.rows_applied,
    coalesce(totals.changed_products, 0), coalesce(totals.changed_fields, 0)
  from metadata_runs runs
  left join change_totals totals on totals.run_key = runs.run_key
  order by runs.started_at desc
  limit least(greatest(coalesce(max_runs, 12), 1), 20);
end;
$$;

create or replace function public.admin_list_sync_changes(
  selected_run_key text,
  page_number integer default 1,
  page_size integer default 50
)
returns table (
  change_id bigint,
  product_code text,
  change_scope text,
  field_name text,
  context_label text,
  previous_value text,
  new_value text,
  changed_at timestamptz,
  total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 50), 1), 100);
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem consultar alteracoes'; end if;
  return query
  select changes.id, changes.product_code, changes.change_scope, changes.field_name,
    changes.context_label, changes.previous_value, changes.new_value, changes.changed_at,
    count(*) over()
  from public.sync_item_changes changes
  join public.sync_metadata metadata on metadata.id = changes.sync_id
  where metadata.run_key = selected_run_key
  order by changes.changed_at desc, changes.product_code, changes.id
  limit safe_size offset ((safe_page - 1) * safe_size);
end;
$$;

create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind;
  version_key uuid;
  sync_key uuid;
  run_key_value text := case when source_name like 'onedrive:%' then source_name else gen_random_uuid()::text end;
  row_data jsonb;
  product_key uuid;
  table_key uuid;
  branch_key uuid;
  applied integer := 0;
  apps jsonb;
  is_onedrive boolean := source_name like 'onedrive:%';
  previous_applications text;
  incoming_applications text;
  price_snapshot_at timestamptz;
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem importar'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then raise exception 'Lote vazio'; end if;

  insert into public.catalog_versions(kind,label,source_name,row_count,is_active,created_by)
  values(import_kind_value,import_kind_value::text || ' ' || to_char(now(),'YYYY-MM-DD HH24:MI'),source_name,jsonb_array_length(rows),false,auth.uid())
  returning id into version_key;
  insert into public.sync_metadata(source_kind,import_kind,source_name,run_key,rows_received,version_id,started_by)
  values(case when is_onedrive then 'ONEDRIVE' else 'MANUAL' end,import_kind_value,source_name,run_key_value,jsonb_array_length(rows),version_key,auth.uid())
  returning id into sync_key;
  perform set_config('debaportal.sync_id', sync_key::text, true);

  begin
    if is_onedrive and import_kind_value = 'PRECOS' then
      price_snapshot_at := clock_timestamp();
      update public.product_prices pp
      set valid_to = price_snapshot_at
      where pp.valid_to is null
        and pp.price_table_id in (
          select pt.id from public.price_tables pt where pt.code in ('PR-PR','SP-SP','PR-SC','PR-SP')
        );
    end if;

    for row_data in select value from jsonb_array_elements(rows) loop
      if import_kind_value in ('PRODUTOS','COMPLETO') then
        if nullif(trim(row_data->>'code'),'') is null or nullif(trim(row_data->>'description'),'') is null then
          raise exception 'Codigo e descricao sao obrigatorios';
        end if;
        insert into public.products(code,description,category,product_line,synonyms,search_text,catalog_version_id)
        values(
          trim(row_data->>'code'),trim(row_data->>'description'),nullif(trim(row_data->>'category'),''),
          nullif(trim(row_data->>'product_line'),''),
          coalesce(array(select jsonb_array_elements_text(coalesce(row_data->'synonyms','[]'::jsonb))),'{}'),
          public.normalize_search(concat_ws(' ',row_data->>'code',row_data->>'description',row_data->>'category',row_data->>'product_line',row_data->>'synonyms')),
          version_key
        )
        on conflict(code) do update set
          description=excluded.description,category=excluded.category,product_line=excluded.product_line,
          synonyms=excluded.synonyms,search_text=excluded.search_text,catalog_version_id=version_key,active=true
        returning id into product_key;
        if row_data ? 'applications' then
          select left(string_agg(concat_ws(' | ', application, nullif(year, '')), '; ' order by application, year), 2000)
          into previous_applications
          from public.product_applications where product_id = product_key;
          select left(string_agg(concat_ws(' | ',
            coalesce(nullif(item->>'application',''), item#>>'{}'), nullif(item->>'year','')
          ), '; ' order by coalesce(nullif(item->>'application',''), item#>>'{}'), item->>'year'), 2000)
          into incoming_applications
          from jsonb_array_elements(coalesce(row_data->'applications','[]'::jsonb)) item;
          if previous_applications is distinct from incoming_applications then
            perform public.record_catalog_change(sync_key, trim(row_data->>'code'), 'APLICACAO', 'Aplicação / Ano', null,
              previous_applications, incoming_applications);
          end if;
          delete from public.product_applications where product_id=product_key;
          for apps in select value from jsonb_array_elements(coalesce(row_data->'applications','[]'::jsonb)) loop
            insert into public.product_applications(product_id,vehicle,model,application,year,search_text)
            values(
              product_key,nullif(apps->>'vehicle',''),nullif(apps->>'model',''),
              coalesce(nullif(apps->>'application',''),apps#>>'{}'),nullif(apps->>'year',''),
              public.normalize_search(concat_ws(' ',apps->>'vehicle',apps->>'model',coalesce(apps->>'application',apps#>>'{}'),apps->>'year'))
            ) on conflict do nothing;
          end loop;
        end if;
      else
        select id into product_key from public.products where code=trim(row_data->>'code');
        if product_key is null then raise exception 'Produto nao encontrado: %',row_data->>'code'; end if;
      end if;

      if import_kind_value in ('PRECOS','COMPLETO') and row_data ? 'price' then
        select id into table_key from public.price_tables
        where (id::text=row_data->>'price_table_id' or code=row_data->>'price_table_code') and active
        order by version desc limit 1;
        if table_key is null then raise exception 'Tabela de preco nao encontrada'; end if;
        update public.product_prices set valid_to=clock_timestamp()
        where product_id=product_key and price_table_id=table_key and valid_to is null;
        insert into public.product_prices(product_id,price_table_id,price,commercial_version_id)
        values(product_key,table_key,(row_data->>'price')::numeric,version_key);
      end if;

      if import_kind_value in ('ESTOQUE','COMPLETO') and row_data ? 'quantity' then
        select id into branch_key from public.branches where code=upper(row_data->>'origin_code');
        if branch_key is null then raise exception 'Filial nao encontrada'; end if;
        insert into public.branch_stock(product_id,branch_id,quantity,commercial_version_id)
        values(product_key,branch_key,(row_data->>'quantity')::numeric,version_key)
        on conflict(product_id,branch_id) do update set
          quantity=excluded.quantity,commercial_version_id=version_key,updated_at=now();
      end if;
      applied := applied + 1;
    end loop;

    if is_onedrive and import_kind_value = 'PRODUTOS' then
      update public.products p set active=false
      where p.active and not exists (
        select 1 from jsonb_array_elements(rows) incoming where trim(incoming.value->>'code') = p.code
      );
    elsif is_onedrive and import_kind_value = 'PRECOS' then
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
    elsif is_onedrive and import_kind_value = 'ESTOQUE' then
      delete from public.branch_stock stock
      using public.branches branch, public.products product
      where branch.id = stock.branch_id and product.id = stock.product_id
        and branch.code in ('PR','SP')
        and not exists (
          select 1 from jsonb_array_elements(rows) incoming
          where trim(incoming.value->>'code') = product.code
            and upper(incoming.value->>'origin_code') = branch.code
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

revoke all on function public.current_catalog_sync_id() from public, anon, authenticated;
revoke all on function public.record_catalog_change(uuid,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.prune_catalog_change_history() from public, anon, authenticated;
revoke all on function public.audit_catalog_product_change() from public, anon, authenticated;
revoke all on function public.audit_catalog_price_change() from public, anon, authenticated;
revoke all on function public.audit_catalog_stock_change() from public, anon, authenticated;
revoke all on function public.admin_list_sync_runs(integer) from public, anon;
revoke all on function public.admin_list_sync_changes(text,integer,integer) from public, anon;
grant execute on function public.admin_list_sync_runs(integer) to authenticated;
grant execute on function public.admin_list_sync_changes(text,integer,integer) to authenticated;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated, service_role;

commit;
