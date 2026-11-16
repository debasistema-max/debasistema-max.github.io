-- Mantem o preco base junto do preco final para a lista comercial mostrar
-- exatamente os dois valores recebidos da planilha autorizada.

begin;

alter table public.product_prices
  add column if not exists base_price numeric(14,2)
  check (base_price is null or base_price >= 0);

comment on column public.product_prices.base_price is
  'Preco sem impostos recebido da planilha comercial para a mesma rota e versao.';

alter function public.import_catalog_batch(text,text,jsonb)
  rename to import_catalog_batch_without_base_price;

revoke all on function public.import_catalog_batch_without_base_price(text,text,jsonb)
from public,anon,authenticated;
grant execute on function public.import_catalog_batch_without_base_price(text,text,jsonb)
to service_role;

create function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  result jsonb;
begin
  if upper(import_kind) = 'PRECOS' and exists (
    select 1
    from jsonb_array_elements(rows) incoming(value)
    where incoming.value ? 'base_price'
      and case
        when jsonb_typeof(incoming.value->'base_price') = 'number'
          then (incoming.value->>'base_price')::numeric < 0
        else true
      end
  ) then
    raise exception 'Preco base invalido no lote';
  end if;

  result := public.import_catalog_batch_without_base_price(import_kind, source_name, rows);
  if upper(import_kind) <> 'PRECOS' or coalesce((result->>'ok')::boolean, false) is not true then
    return result;
  end if;

  with incoming_prices as (
    select
      trim(incoming.value->>'code') as product_code,
      nullif(incoming.value->>'base_price', '')::numeric as base_price,
      coalesce(incoming.value->>'price_table_id', incoming.value->>'price_table_code') as table_reference
    from jsonb_array_elements(rows) incoming(value)
  ), resolved as (
    select product.id as product_id, price_table.id as price_table_id, incoming.base_price
    from incoming_prices incoming
    join public.products product on product.code = incoming.product_code
    join lateral (
      select candidate.id
      from public.price_tables candidate
      where candidate.active and (
        candidate.id::text = incoming.table_reference
        or candidate.code = incoming.table_reference
      )
      order by candidate.version desc
      limit 1
    ) price_table on true
  )
  update public.product_prices current_price
  set base_price = resolved.base_price
  from resolved
  where current_price.product_id = resolved.product_id
    and current_price.price_table_id = resolved.price_table_id
    and current_price.valid_to is null;

  return result;
end;
$$;

revoke all on function public.import_catalog_batch(text,text,jsonb) from public,anon;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated,service_role;

create function public.search_catalog_commercial(
  search_text text default '', destination_state text default null, origin_code text default null,
  price_table_id uuid default null, category_filter text default null, line_filter text default null,
  brand_filter text default null, in_stock_only boolean default false,
  page_number integer default 1, page_size integer default 25
)
returns table (
  product_id uuid, code text, description text, category text, product_line text, brand text,
  applications text[], application_years text[], synonyms text[], price numeric, base_price numeric,
  price_version integer, stock_origin numeric, stock_pr numeric, stock_sp numeric,
  availability text, total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    catalog.product_id, catalog.code, catalog.description, catalog.category,
    catalog.product_line, catalog.brand, catalog.applications, catalog.application_years,
    catalog.synonyms, catalog.price, current_price.base_price, catalog.price_version,
    catalog.stock_origin, catalog.stock_pr, catalog.stock_sp, catalog.availability,
    catalog.total_count
  from public.search_catalog($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) catalog
  left join lateral (
    select stored.base_price
    from public.product_prices stored
    where stored.product_id = catalog.product_id
      and stored.price_table_id = $4
      and stored.valid_from <= now()
      and (stored.valid_to is null or stored.valid_to > now())
    order by stored.valid_from desc
    limit 1
  ) current_price on true;
$$;

revoke all on function public.search_catalog_commercial(text,text,text,uuid,text,text,text,boolean,integer,integer)
from public,anon;
grant execute on function public.search_catalog_commercial(text,text,text,uuid,text,text,text,boolean,integer,integer)
to authenticated;

commit;
