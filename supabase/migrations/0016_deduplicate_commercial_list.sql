-- Remove repeticoes equivalentes de aplicacao/ano e devolve vetores unicos
-- para consulta, lista comercial e exportacoes.

begin;

delete from public.product_applications
where id in (
  select id
  from (
    select id, row_number() over (
      partition by product_id, public.normalize_search(application), public.normalize_search(coalesce(year, ''))
      order by created_at, id
    ) as duplicate_number
    from public.product_applications
  ) duplicates
  where duplicate_number > 1
);

drop index if exists public.product_applications_product_application_year_key;

create unique index if not exists product_applications_product_application_year_normalized_key
on public.product_applications(
  product_id,
  public.normalize_search(application),
  public.normalize_search(coalesce(year, ''))
);

alter function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)
rename to search_catalog_raw;

revoke all on function public.search_catalog_raw(text,text,text,uuid,text,text,boolean,integer,integer)
from public,anon,authenticated,service_role;

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
language sql stable security definer set search_path = public, pg_temp as $$
  select
    result.product_id,
    result.code,
    result.description,
    result.category,
    result.product_line,
    coalesce(array(
      select min(trim(application_value))
      from unnest(result.applications) application_value
      where nullif(trim(application_value), '') is not null
      group by public.normalize_search(application_value)
      order by public.normalize_search(application_value)
    ), '{}'::text[]) as applications,
    coalesce(array(
      select min(trim(year_value))
      from unnest(result.application_years) year_value
      where nullif(trim(year_value), '') is not null
      group by public.normalize_search(year_value)
      order by public.normalize_search(year_value)
    ), '{}'::text[]) as application_years,
    result.synonyms,
    result.price,
    result.price_version,
    result.stock_origin,
    result.stock_pr,
    result.stock_sp,
    result.availability,
    result.total_count
  from public.search_catalog_raw(
    search_text,
    destination_state,
    origin_code,
    price_table_id,
    category_filter,
    line_filter,
    in_stock_only,
    page_number,
    page_size
  ) result;
$$;

revoke all on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)
from public,anon;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)
to authenticated;

commit;
