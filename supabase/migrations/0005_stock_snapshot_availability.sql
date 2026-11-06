create or replace function public.search_catalog(
  search_text text default '', destination_state text default null, origin_code text default null,
  price_table_id uuid default null, category_filter text default null, line_filter text default null,
  in_stock_only boolean default false, page_number integer default 1, page_size integer default 25
)
returns table (
  product_id uuid, code text, description text, category text, product_line text,
  applications text[], synonyms text[], price numeric, price_version integer,
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
      and pt.active
      and pt.valid_from <= current_date
      and (pt.valid_to is null or pt.valid_to >= current_date)
      and (search_catalog.destination_state is null or pt.destination_state is null or pt.destination_state = upper(search_catalog.destination_state))
      and (branch_key is null or pt.origin_branch_id is null or pt.origin_branch_id = branch_key)
  ) then raise exception 'Tabela comercial invalida para destino ou origem'; end if;
  if price_table_id is not null and not public.is_admin() and not exists (
    select 1 from public.profile_price_table_access a where a.profile_id = auth.uid() and a.price_table_id = search_catalog.price_table_id
  ) then raise exception 'Tabela nao autorizada'; end if;

  select exists (
    select 1 from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'PR'
  ) into pr_snapshot_available;
  select exists (
    select 1 from public.branch_stock bs join public.branches b on b.id = bs.branch_id where b.code = 'SP'
  ) into sp_snapshot_available;
  select branch_key is not null and exists (
    select 1 from public.branch_stock bs where bs.branch_id = branch_key
  ) into origin_snapshot_available;

  return query
  with filtered as (
    select p.*,
      coalesce((select array_agg(pa.application order by pa.application) from public.product_applications pa where pa.product_id = p.id), '{}') as apps,
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
    where p.active
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
  select q.id, q.code, q.description, q.category, q.product_line, q.apps, q.synonyms,
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

grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer) to authenticated;
