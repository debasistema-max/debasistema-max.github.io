-- Preserva aplicacao e ano em campos separados para consulta e listas comerciais.

begin;

alter table public.product_applications
add column if not exists year text;

alter table public.product_applications
drop constraint if exists product_applications_product_id_application_key;

create unique index if not exists product_applications_product_application_year_key
on public.product_applications(product_id, application, coalesce(year, ''));

create or replace function public.prepare_application_search()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.search_text := public.normalize_search(concat_ws(' ', new.vehicle, new.model, new.application, new.year));
  return new;
end;
$$;

drop trigger if exists applications_prepare_search on public.product_applications;
create trigger applications_prepare_search before insert or update of vehicle,model,application,year
on public.product_applications for each row execute function public.prepare_application_search();

create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind;
  version_key uuid;
  sync_key uuid;
  row_data jsonb;
  product_key uuid;
  table_key uuid;
  branch_key uuid;
  applied integer := 0;
  apps jsonb;
  is_onedrive boolean := source_name like 'onedrive:%';
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem importar'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then raise exception 'Lote vazio'; end if;

  insert into public.catalog_versions(kind,label,source_name,row_count,is_active,created_by)
  values(import_kind_value,import_kind_value::text || ' ' || to_char(now(),'YYYY-MM-DD HH24:MI'),source_name,jsonb_array_length(rows),false,auth.uid())
  returning id into version_key;
  insert into public.sync_metadata(source_kind,import_kind,source_name,rows_received,version_id,started_by)
  values(case when is_onedrive then 'ONEDRIVE' else 'MANUAL' end,import_kind_value,source_name,jsonb_array_length(rows),version_key,auth.uid())
  returning id into sync_key;

  begin
    if is_onedrive and import_kind_value = 'PRECOS' then
      update public.product_prices pp
      set valid_to = clock_timestamp()
      where pp.valid_to is null
        and pp.price_table_id in (
          select pt.id from public.price_tables pt where pt.code in ('PR-PR','SP-SP','PR-SC','PR-SP')
        );
    elsif is_onedrive and import_kind_value = 'ESTOQUE' then
      delete from public.branch_stock bs
      using public.branches b
      where b.id = bs.branch_id and b.code in ('PR','SP');
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
    end if;

    update public.catalog_versions set is_active=false where kind=import_kind_value and id<>version_key;
    update public.catalog_versions set is_active=true where id=version_key;
    update public.sync_metadata set status='CONCLUIDO',rows_applied=applied,finished_at=now() where id=sync_key;
    return jsonb_build_object('ok',true,'version_id',version_key,'rows_applied',applied,'sync_id',sync_key);
  exception when others then
    update public.sync_metadata set status='FALHOU',error_count=1,error_message=left(sqlerrm,1000),finished_at=now() where id=sync_key;
    return jsonb_build_object('ok',false,'error',sqlerrm,'sync_id',sync_key);
  end;
end;
$$;

drop function if exists public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer);

create function public.search_catalog(
  search_text text default '', destination_state text default null, origin_code text default null,
  price_table_id uuid default null, category_filter text default null, line_filter text default null,
  in_stock_only boolean default false, page_number integer default 1, page_size integer default 25
)
returns table (
  product_id uuid, code text, description text, category text, product_line text,
  applications text[], application_years text[], synonyms text[], price numeric, price_version integer,
  stock_origin numeric, stock_pr numeric, stock_sp numeric, availability text, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  branch_key uuid;
  term text := public.normalize_search(search_text);
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 25), 1), 100);
  pr_snapshot_available boolean;
  sp_snapshot_available boolean;
  origin_snapshot_available boolean;
begin
  if not public.is_active_user() then raise exception 'Acesso negado'; end if;
  select b.id into branch_key from public.branches b where b.code = upper(origin_code) and b.active;
  if origin_code is not null and branch_key is null then raise exception 'Origem invalida'; end if;
  if branch_key is not null and not public.is_admin() and not exists (
    select 1 from public.profile_branch_access a where a.profile_id = auth.uid() and a.branch_id = branch_key
  ) then raise exception 'Origem nao autorizada'; end if;
  if price_table_id is not null and not exists (
    select 1 from public.price_tables pt
    where pt.id = search_catalog.price_table_id
      and pt.active and pt.valid_from <= current_date
      and (pt.valid_to is null or pt.valid_to >= current_date)
      and (search_catalog.destination_state is null or pt.destination_state is null or pt.destination_state = upper(search_catalog.destination_state))
      and (branch_key is null or pt.origin_branch_id is null or pt.origin_branch_id = branch_key)
  ) then raise exception 'Tabela comercial invalida para destino ou origem'; end if;
  if price_table_id is not null and not public.is_admin() and not exists (
    select 1 from public.profile_price_table_access a where a.profile_id = auth.uid() and a.price_table_id = search_catalog.price_table_id
  ) then raise exception 'Tabela nao autorizada'; end if;

  select exists (select 1 from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'PR') into pr_snapshot_available;
  select exists (select 1 from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'SP') into sp_snapshot_available;
  select branch_key is not null and exists (select 1 from public.branch_stock bs where bs.branch_id = branch_key) into origin_snapshot_available;

  return query
  with filtered as (
    select p.*,
      coalesce((select array_agg(pa.application order by pa.application) from public.product_applications pa where pa.product_id = p.id), '{}') as apps,
      coalesce((select array_agg(y.year order by y.year) from (
        select distinct pa.year from public.product_applications pa
        where pa.product_id = p.id and nullif(trim(pa.year), '') is not null
      ) y), '{}') as years,
      case when pr_snapshot_available then coalesce((
        select sum(bs.quantity) from public.branch_stock bs join public.branches b on b.id = bs.branch_id
        where bs.product_id = p.id and b.code = 'PR' and (public.is_admin() or exists (
          select 1 from public.profile_branch_access a where a.profile_id = auth.uid() and a.branch_id = b.id
        ))
      ), 0) else null end as qty_pr,
      case when sp_snapshot_available then coalesce((
        select sum(bs.quantity) from public.branch_stock bs join public.branches b on b.id = bs.branch_id
        where bs.product_id = p.id and b.code = 'SP' and (public.is_admin() or exists (
          select 1 from public.profile_branch_access a where a.profile_id = auth.uid() and a.branch_id = b.id
        ))
      ), 0) else null end as qty_sp,
      case when origin_snapshot_available then coalesce((
        select bs.quantity from public.branch_stock bs where bs.product_id = p.id and bs.branch_id = branch_key
      ), 0) else null end as qty_origin
    from public.products p
    where p.active and not p.admin_inactive
      and (category_filter is null or p.category = category_filter)
      and (line_filter is null or p.product_line = line_filter)
      and (term = '' or p.search_text like '%' || term || '%' or exists (
        select 1 from public.product_applications pa where pa.product_id = p.id and pa.search_text like '%' || term || '%'
      ))
  ), priced as (
    select f.*, pp.price, pt.version as table_version
    from filtered f
    left join lateral (
      select x.* from public.product_prices x
      where x.product_id = f.id and x.price_table_id = search_catalog.price_table_id
        and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())
      order by x.valid_from desc limit 1
    ) pp on true
    left join public.price_tables pt on pt.id = search_catalog.price_table_id
    where (not in_stock_only or f.qty_origin > 0)
      and (search_catalog.destination_state is null or pt.destination_state is null or pt.destination_state = upper(search_catalog.destination_state))
      and (branch_key is null or pt.origin_branch_id is null or pt.origin_branch_id = branch_key)
  )
  select q.id, q.code, q.description, q.category, q.product_line, q.apps, q.years, q.synonyms,
    q.price, q.table_version, q.qty_origin, q.qty_pr, q.qty_sp,
    case
      when q.qty_origin is null then 'SEM_DADOS'
      when q.qty_origin > 50 then 'VERDE'
      when q.qty_origin > 0 then 'AMARELO'
      else 'VERMELHO'
    end,
    count(*) over()
  from priced q
  order by q.code
  limit safe_size offset ((safe_page - 1) * safe_size);
end;
$$;

revoke all on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer) from public, anon;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer) to authenticated;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated, service_role;

commit;
