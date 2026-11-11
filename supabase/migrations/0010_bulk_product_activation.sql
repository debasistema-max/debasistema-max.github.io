-- Inativacao comercial manual, persistente entre sincronizacoes do catalogo.

begin;

alter table public.products
add column if not exists admin_inactive boolean not null default false;

create index if not exists products_admin_inactive_idx
on public.products(admin_inactive, code)
where active;

drop policy if exists products_read on public.products;
create policy products_read on public.products for select using (
  public.is_admin() or (public.is_active_user() and active and not admin_inactive)
);

drop policy if exists applications_read on public.product_applications;
create policy applications_read on public.product_applications for select using (
  public.is_admin() or (
    public.is_active_user() and exists (
      select 1 from public.products p
      where p.id = product_applications.product_id and p.active and not p.admin_inactive
    )
  )
);

drop policy if exists product_prices_read on public.product_prices;
create policy product_prices_read on public.product_prices for select using (
  public.is_admin() or (
    public.is_active_user()
    and exists (
      select 1 from public.profile_price_table_access a
      where a.profile_id = auth.uid() and a.price_table_id = product_prices.price_table_id
    )
    and exists (
      select 1 from public.products p
      where p.id = product_prices.product_id and p.active and not p.admin_inactive
    )
  )
);

drop policy if exists branch_stock_read on public.branch_stock;
create policy branch_stock_read on public.branch_stock for select using (
  public.is_admin() or (
    public.is_active_user()
    and exists (
      select 1 from public.profile_branch_access a
      where a.profile_id = auth.uid() and a.branch_id = branch_stock.branch_id
    )
    and exists (
      select 1 from public.products p
      where p.id = branch_stock.product_id and p.active and not p.admin_inactive
    )
  )
);

create or replace function public.admin_list_products(
  search_text text default '', status_filter text default 'ATIVOS',
  page_number integer default 1, page_size integer default 50
)
returns table (
  product_id uuid, code text, description text, category text, product_line text,
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
  select p.id, p.code, p.description, p.category, p.product_line,
    p.active and not p.admin_inactive,
    count(*) over()
  from public.products p
  where p.active
    and ((status_value = 'ATIVOS' and not p.admin_inactive) or (status_value = 'INATIVOS' and p.admin_inactive))
    and (term = '' or p.search_text like '%' || term || '%')
  order by p.code
  limit safe_size offset ((safe_page - 1) * safe_size);
end;
$$;

create or replace function public.admin_set_products_active(product_ids uuid[], new_active boolean)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  requested_count integer;
  changed_count integer;
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem gerenciar produtos'; end if;
  requested_count := coalesce(cardinality(product_ids), 0);
  if requested_count = 0 or requested_count > 500 then
    raise exception 'Selecione entre 1 e 500 produtos';
  end if;
  if new_active is null then raise exception 'Situacao obrigatoria'; end if;

  update public.products p
  set admin_inactive = not new_active
  where p.id = any(product_ids) and p.active;
  get diagnostics changed_count = row_count;

  if changed_count <> (select count(distinct id) from unnest(product_ids) as selected(id)) then
    raise exception 'Um ou mais produtos nao estao disponiveis no catalogo atual';
  end if;
  return changed_count;
end;
$$;

create or replace function public.ensure_commercial_item_product_active()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.product_id is not null and not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.active and not p.admin_inactive
  ) then
    raise exception 'Produto inativo nao pode ser incluido em documento comercial';
  end if;
  return new;
end;
$$;

drop trigger if exists commercial_items_active_product on public.commercial_document_items;
create trigger commercial_items_active_product
before insert or update of product_id on public.commercial_document_items
for each row execute function public.ensure_commercial_item_product_active();

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

revoke all on function public.admin_list_products(text,text,integer,integer) from public, anon;
revoke all on function public.admin_set_products_active(uuid[],boolean) from public, anon;
grant execute on function public.admin_list_products(text,text,integer,integer) to authenticated;
grant execute on function public.admin_set_products_active(uuid[],boolean) to authenticated;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer) to authenticated;

commit;
