-- Separa a marca do produto da linha comercial (Leve, Pesada ou Utilitario)
-- e mantem a importacao e a busca compativeis com o portal publicado.

begin;

alter table public.products
  add column if not exists commercial_line text;

alter table public.products
  drop constraint if exists products_commercial_line_check;
alter table public.products
  add constraint products_commercial_line_check
  check (commercial_line is null or commercial_line in ('Leve', 'Pesada', 'Utilitário'));

update public.products
set commercial_line = case public.normalize_search(product_line)
  when 'leve' then 'Leve'
  when 'pesada' then 'Pesada'
  when 'pesado' then 'Pesada'
  when 'utilitario' then 'Utilitário'
  when 'utilitarios' then 'Utilitário'
  else commercial_line
end
where commercial_line is null;

create index if not exists products_commercial_line_idx
on public.products(commercial_line) where active and not admin_inactive;

create or replace function public.prepare_product_search()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.code := trim(new.code);
  new.description := trim(new.description);
  new.search_text := public.normalize_search(concat_ws(
    ' ', new.code, new.description, new.category, new.commercial_line,
    new.product_line, array_to_string(new.synonyms, ' ')
  ));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists products_prepare_search on public.products;
create trigger products_prepare_search
before insert or update of code,description,category,commercial_line,product_line,synonyms
on public.products for each row execute function public.prepare_product_search();

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
  if old.commercial_line is distinct from new.commercial_line then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Linha', null, old.commercial_line, new.commercial_line);
  end if;
  if old.product_line is distinct from new.product_line then
    perform public.record_catalog_change(sync_key, new.code, 'PRODUTO', 'Marca', null, old.product_line, new.product_line);
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

alter function public.import_catalog_batch_legacy(text,text,jsonb)
rename to import_catalog_batch_legacy_base;

revoke all on function public.import_catalog_batch_legacy_base(text,text,jsonb)
from public,anon,authenticated,service_role;

create function public.import_catalog_batch_legacy(import_kind text, source_name text, rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  result jsonb;
begin
  result := public.import_catalog_batch_legacy_base(import_kind, source_name, rows);
  if coalesce((result->>'ok')::boolean, false) and upper(import_kind) = 'PRODUTOS' then
    update public.products product
    set commercial_line = case public.normalize_search(incoming.value->>'commercial_line')
      when 'leve' then 'Leve'
      when 'pesada' then 'Pesada'
      when 'pesado' then 'Pesada'
      when 'utilitario' then 'Utilitário'
      when 'utilitarios' then 'Utilitário'
      else null
    end
    from jsonb_array_elements(rows) incoming
    where product.code = trim(incoming.value->>'code');
  end if;
  return result;
end;
$$;

revoke all on function public.import_catalog_batch_legacy(text,text,jsonb)
from public,anon;
grant execute on function public.import_catalog_batch_legacy(text,text,jsonb)
to authenticated,service_role;

drop function if exists public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer);

create function public.search_catalog(
  search_text text default '', destination_state text default null, origin_code text default null,
  price_table_id uuid default null, category_filter text default null, line_filter text default null,
  brand_filter text default null, in_stock_only boolean default false,
  page_number integer default 1, page_size integer default 25
)
returns table (
  product_id uuid, code text, description text, category text, product_line text, brand text,
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
      and (category_filter is null or p.category = any(string_to_array(category_filter, chr(31))))
      and (line_filter is null or p.commercial_line = any(string_to_array(line_filter, chr(31))))
      and (brand_filter is null or p.product_line = any(string_to_array(brand_filter, chr(31))))
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
  select q.id, q.code, q.description, q.category, q.commercial_line, q.product_line,
    q.apps, q.years, q.synonyms, q.price, q.table_version, q.qty_origin, q.qty_pr, q.qty_sp,
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

revoke all on function public.search_catalog(text,text,text,uuid,text,text,text,boolean,integer,integer)
from public,anon;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,text,boolean,integer,integer)
to authenticated;

drop function if exists public.admin_list_products(text,text,integer,integer);
create function public.admin_list_products(
  search_text text default '', status_filter text default 'ATIVOS',
  page_number integer default 1, page_size integer default 50
)
returns table (
  product_id uuid, code text, description text, category text, product_line text, brand text,
  effective_active boolean, total_count bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  term text := public.normalize_search(search_text);
  status_value text := upper(coalesce(status_filter, 'ATIVOS'));
  safe_page integer := greatest(coalesce(page_number, 1), 1);
  safe_size integer := least(greatest(coalesce(page_size, 50), 1), 100);
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem gerenciar produtos'; end if;
  if status_value not in ('ATIVOS', 'INATIVOS') then raise exception 'Filtro de situacao invalido'; end if;
  return query
  select p.id, p.code, p.description, p.category, p.commercial_line, p.product_line,
    p.active and not p.admin_inactive, count(*) over()
  from public.products p
  where p.active
    and ((status_value = 'ATIVOS' and not p.admin_inactive) or (status_value = 'INATIVOS' and p.admin_inactive))
    and (term = '' or p.search_text like '%' || term || '%')
  order by p.code
  limit safe_size offset ((safe_page - 1) * safe_size);
end;
$$;

revoke all on function public.admin_list_products(text,text,integer,integer)
from public,anon;
grant execute on function public.admin_list_products(text,text,integer,integer)
to authenticated;

commit;
