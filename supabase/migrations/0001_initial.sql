-- DebaPortal - schema inicial independente.
-- Execute somente em um projeto Supabase exclusivo do DebaPortal.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create type public.app_role as enum ('ADMIN', 'VENDEDOR');
create type public.document_type as enum ('PEDIDO', 'COTACAO');
create type public.document_status as enum ('RASCUNHO', 'GERADO', 'ENVIADO', 'CANCELADO');
create type public.sync_status as enum ('EM_ANDAMENTO', 'CONCLUIDO', 'FALHOU');
create type public.catalog_version_kind as enum ('PRODUTOS', 'PRECOS', 'ESTOQUE', 'COMPLETO');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  role public.app_role not null default 'VENDEDOR',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.catalog_versions (
  id uuid primary key default gen_random_uuid(),
  kind public.catalog_version_kind not null,
  label text not null,
  source_name text,
  content_hash text,
  row_count integer not null default 0 check (row_count >= 0),
  is_active boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text not null,
  state char(2) not null check (state ~ '^[A-Z]{2}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,
  category text,
  product_line text,
  synonyms text[] not null default '{}',
  search_text text not null default '',
  active boolean not null default true,
  catalog_version_id uuid references public.catalog_versions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_applications (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  vehicle text,
  model text,
  application text not null,
  search_text text not null default '',
  created_at timestamptz not null default now(),
  unique (product_id, application)
);

create table public.price_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  version integer not null default 1 check (version > 0),
  destination_state char(2) check (destination_state is null or destination_state ~ '^[A-Z]{2}$'),
  origin_branch_id uuid references public.branches(id) on delete restrict,
  valid_from date not null default current_date,
  valid_to date,
  active boolean not null default true,
  commercial_version_id uuid references public.catalog_versions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, version),
  check (valid_to is null or valid_to >= valid_from)
);

create table public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  price_table_id uuid not null references public.price_tables(id) on delete cascade,
  price numeric(14,2) not null check (price >= 0),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  commercial_version_id uuid references public.catalog_versions(id) on delete set null,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);

create unique index product_prices_one_current
  on public.product_prices(product_id, price_table_id)
  where valid_to is null;

create table public.branch_stock (
  product_id uuid not null references public.products(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  commercial_version_id uuid references public.catalog_versions(id) on delete set null,
  primary key (product_id, branch_id)
);

create table public.profile_price_table_access (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  price_table_id uuid not null references public.price_tables(id) on delete cascade,
  primary key (profile_id, price_table_id)
);

create table public.profile_branch_access (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  primary key (profile_id, branch_id)
);

create sequence public.commercial_document_number_seq;

create table public.commercial_documents (
  id uuid primary key default gen_random_uuid(),
  document_type public.document_type not null,
  status public.document_status not null default 'RASCUNHO',
  document_number text unique,
  seller_id uuid not null references public.profiles(id) on delete restrict,
  destination_state char(2) not null check (destination_state ~ '^[A-Z]{2}$'),
  origin_branch_id uuid not null references public.branches(id) on delete restrict,
  price_table_id uuid not null references public.price_tables(id) on delete restrict,
  price_table_code_snapshot text not null,
  price_table_version_snapshot integer not null,
  customer_cnpj varchar(14),
  customer_name text not null,
  customer_state char(2) check (customer_state is null or customer_state ~ '^[A-Z]{2}$'),
  notes text,
  subtotal numeric(16,2) not null default 0 check (subtotal >= 0),
  total numeric(16,2) not null default 0 check (total >= 0),
  source_quotation_id uuid references public.commercial_documents(id) on delete set null,
  generated_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_cnpj is null or customer_cnpj ~ '^[0-9]{14}$'),
  check (length(trim(customer_name)) > 0),
  check (source_quotation_id is null or document_type = 'PEDIDO')
);

create table public.commercial_document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.commercial_documents(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  product_id uuid references public.products(id) on delete restrict,
  product_code_snapshot text not null,
  description_snapshot text not null,
  application_snapshot text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  stock_snapshot numeric(14,3),
  price_record_id uuid references public.product_prices(id) on delete set null,
  line_total numeric(16,2) generated always as (round(quantity * unit_price, 2)) stored,
  created_at timestamptz not null default now(),
  unique (document_id, line_number)
);

create table public.sync_metadata (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('MANUAL', 'ONEDRIVE')),
  import_kind public.catalog_version_kind not null,
  source_name text,
  status public.sync_status not null default 'EM_ANDAMENTO',
  rows_received integer not null default 0 check (rows_received >= 0),
  rows_applied integer not null default 0 check (rows_applied >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  error_message text,
  version_id uuid references public.catalog_versions(id) on delete set null,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.drive_integration_settings (
  id boolean primary key default true check (id),
  provider text not null default 'ONEDRIVE' check (provider = 'ONEDRIVE'),
  drive_id text,
  folder_id text,
  enabled boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index products_category_idx on public.products(category) where active;
create index products_line_idx on public.products(product_line) where active;
create index products_search_trgm_idx on public.products using gin(search_text extensions.gin_trgm_ops);
create index product_applications_product_idx on public.product_applications(product_id);
create index product_applications_search_trgm_idx on public.product_applications using gin(search_text extensions.gin_trgm_ops);
create index product_prices_lookup_idx on public.product_prices(price_table_id, product_id, valid_from desc);
create index branch_stock_branch_idx on public.branch_stock(branch_id, product_id);
create index documents_seller_created_idx on public.commercial_documents(seller_id, created_at desc);
create index documents_type_status_idx on public.commercial_documents(document_type, status, created_at desc);
create index document_items_document_idx on public.commercial_document_items(document_id, line_number);
create index sync_metadata_started_idx on public.sync_metadata(started_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger branches_touch before update on public.branches for each row execute function public.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();
create trigger price_tables_touch before update on public.price_tables for each row execute function public.touch_updated_at();
create trigger documents_touch before update on public.commercial_documents for each row execute function public.touch_updated_at();
create trigger drive_settings_touch before update on public.drive_integration_settings for each row execute function public.touch_updated_at();

create or replace function public.normalize_search(value text)
returns text language sql immutable parallel safe set search_path = public, pg_temp as $$
  select lower(regexp_replace(coalesce(value, ''), '[^[:alnum:]]+', ' ', 'g'));
$$;

create or replace function public.prepare_product_search()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.search_text := public.normalize_search(concat_ws(' ', new.code, new.description, new.category, new.product_line, array_to_string(new.synonyms, ' ')));
  return new;
end;
$$;

create or replace function public.prepare_application_search()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.search_text := public.normalize_search(concat_ws(' ', new.vehicle, new.model, new.application));
  return new;
end;
$$;

create trigger products_prepare_search before insert or update of code,description,category,product_line,synonyms
on public.products for each row execute function public.prepare_product_search();
create trigger applications_prepare_search before insert or update of vehicle,model,application
on public.product_applications for each row execute function public.prepare_application_search();

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id, email, full_name, role, active)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''), 'VENDEDOR', false)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'ADMIN');
$$;

create or replace function public.valid_cnpj(value text)
returns boolean language plpgsql immutable parallel safe set search_path = public, pg_temp as $$
declare
  digits text := regexp_replace(coalesce(value, ''), '\D', '', 'g');
  sum_value integer;
  remainder integer;
  check_digit integer;
  i integer;
begin
  if length(digits) <> 14 or digits ~ '^(.)\1{13}$' then return false; end if;
  sum_value := 0;
  for i in 1..12 loop
    sum_value := sum_value + substr(digits, i, 1)::integer * (array[5,4,3,2,9,8,7,6,5,4,3,2])[i];
  end loop;
  remainder := sum_value % 11;
  check_digit := case when remainder < 2 then 0 else 11 - remainder end;
  if check_digit <> substr(digits, 13, 1)::integer then return false; end if;
  sum_value := 0;
  for i in 1..13 loop
    sum_value := sum_value + substr(digits, i, 1)::integer * (array[6,5,4,3,2,9,8,7,6,5,4,3,2])[i];
  end loop;
  remainder := sum_value % 11;
  check_digit := case when remainder < 2 then 0 else 11 - remainder end;
  return check_digit = substr(digits, 14, 1)::integer;
end;
$$;

alter table public.profiles enable row level security;
alter table public.catalog_versions enable row level security;
alter table public.branches enable row level security;
alter table public.products enable row level security;
alter table public.product_applications enable row level security;
alter table public.price_tables enable row level security;
alter table public.product_prices enable row level security;
alter table public.branch_stock enable row level security;
alter table public.profile_price_table_access enable row level security;
alter table public.profile_branch_access enable row level security;
alter table public.commercial_documents enable row level security;
alter table public.commercial_document_items enable row level security;
alter table public.sync_metadata enable row level security;
alter table public.drive_integration_settings enable row level security;

create policy profiles_read on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_admin_write on public.profiles for update using (public.is_admin()) with check (public.is_admin());

create policy catalog_versions_read on public.catalog_versions for select using (public.is_active_user());
create policy catalog_versions_admin on public.catalog_versions for all using (public.is_admin()) with check (public.is_admin());
create policy branches_read on public.branches for select using (
  public.is_admin() or (public.is_active_user() and exists(select 1 from public.profile_branch_access a where a.profile_id = auth.uid() and a.branch_id = id))
);
create policy branches_admin on public.branches for all using (public.is_admin()) with check (public.is_admin());
create policy products_read on public.products for select using (public.is_active_user());
create policy products_admin on public.products for all using (public.is_admin()) with check (public.is_admin());
create policy applications_read on public.product_applications for select using (public.is_active_user());
create policy applications_admin on public.product_applications for all using (public.is_admin()) with check (public.is_admin());
create policy price_tables_read on public.price_tables for select using (
  public.is_admin() or (public.is_active_user() and exists(select 1 from public.profile_price_table_access a where a.profile_id = auth.uid() and a.price_table_id = id))
);
create policy price_tables_admin on public.price_tables for all using (public.is_admin()) with check (public.is_admin());
create policy product_prices_read on public.product_prices for select using (
  public.is_admin() or (public.is_active_user() and exists(select 1 from public.profile_price_table_access a where a.profile_id = auth.uid() and a.price_table_id = product_prices.price_table_id))
);
create policy product_prices_admin on public.product_prices for all using (public.is_admin()) with check (public.is_admin());
create policy branch_stock_read on public.branch_stock for select using (
  public.is_admin() or (public.is_active_user() and exists(select 1 from public.profile_branch_access a where a.profile_id = auth.uid() and a.branch_id = branch_stock.branch_id))
);
create policy branch_stock_admin on public.branch_stock for all using (public.is_admin()) with check (public.is_admin());
create policy price_access_read on public.profile_price_table_access for select using (profile_id = auth.uid() or public.is_admin());
create policy price_access_admin on public.profile_price_table_access for all using (public.is_admin()) with check (public.is_admin());
create policy branch_access_read on public.profile_branch_access for select using (profile_id = auth.uid() or public.is_admin());
create policy branch_access_admin on public.profile_branch_access for all using (public.is_admin()) with check (public.is_admin());
create policy documents_read on public.commercial_documents for select using (public.is_admin() or (public.is_active_user() and seller_id = auth.uid()));
create policy document_items_read on public.commercial_document_items for select using (
  exists(select 1 from public.commercial_documents d where d.id = document_id and (public.is_admin() or (public.is_active_user() and d.seller_id = auth.uid())))
);
create policy sync_read on public.sync_metadata for select using (public.is_admin());
create policy sync_admin on public.sync_metadata for all using (public.is_admin()) with check (public.is_admin());
create policy drive_admin on public.drive_integration_settings for all using (public.is_admin()) with check (public.is_admin());

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

  return query
  with filtered as (
    select p.*,
      coalesce((select array_agg(pa.application order by pa.application) from public.product_applications pa where pa.product_id = p.id), '{}') as apps,
      coalesce((select sum(bs.quantity) from public.branch_stock bs join public.branches b on b.id=bs.branch_id
        where bs.product_id=p.id and b.code='PR' and (public.is_admin() or exists (
          select 1 from public.profile_branch_access a where a.profile_id=auth.uid() and a.branch_id=b.id
        ))),0) as qty_pr,
      coalesce((select sum(bs.quantity) from public.branch_stock bs join public.branches b on b.id=bs.branch_id
        where bs.product_id=p.id and b.code='SP' and (public.is_admin() or exists (
          select 1 from public.profile_branch_access a where a.profile_id=auth.uid() and a.branch_id=b.id
        ))),0) as qty_sp,
      coalesce((select bs.quantity from public.branch_stock bs where bs.product_id=p.id and bs.branch_id=branch_key),0) as qty_origin
    from public.products p
    where p.active
      and (category_filter is null or p.category = category_filter)
      and (line_filter is null or p.product_line = line_filter)
      and (term = '' or p.search_text like '%'||term||'%' or exists (
        select 1 from public.product_applications pa where pa.product_id=p.id and pa.search_text like '%'||term||'%'
      ))
  ), priced as (
    select f.*, pp.price, pt.version as table_version
    from filtered f
    left join lateral (
      select x.* from public.product_prices x
      where x.product_id=f.id and x.price_table_id=search_catalog.price_table_id
        and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())
      order by x.valid_from desc limit 1
    ) pp on true
    left join public.price_tables pt on pt.id=search_catalog.price_table_id
    where (not in_stock_only or f.qty_origin > 0)
      and (search_catalog.destination_state is null or pt.destination_state is null or pt.destination_state = upper(search_catalog.destination_state))
      and (branch_key is null or pt.origin_branch_id is null or pt.origin_branch_id = branch_key)
  )
  select q.id, q.code, q.description, q.category, q.product_line, q.apps, q.synonyms,
    q.price, q.table_version, q.qty_origin, q.qty_pr, q.qty_sp,
    case when q.qty_origin > 50 then 'VERDE' when q.qty_origin > 0 then 'AMARELO' else 'VERMELHO' end,
    count(*) over()
  from priced q
  order by q.code
  limit safe_size offset ((safe_page - 1) * safe_size);
end;
$$;

create or replace function public.save_commercial_document(document_payload jsonb, items_payload jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  document_key uuid := nullif(document_payload ->> 'id','')::uuid;
  document_kind public.document_type := upper(coalesce(document_payload ->> 'document_type',''))::public.document_type;
  branch_key uuid;
  table_row public.price_tables%rowtype;
  item jsonb;
  product_row public.products%rowtype;
  price_row public.product_prices%rowtype;
  line_no integer := 0;
  requested_qty numeric;
  cnpj_digits text := regexp_replace(coalesce(document_payload ->> 'customer_cnpj',''), '\D','','g');
begin
  if not public.is_active_user() then raise exception 'Acesso negado'; end if;
  if jsonb_typeof(items_payload) <> 'array' or jsonb_array_length(items_payload)=0 then raise exception 'Documento sem itens'; end if;
  if cnpj_digits <> '' and not public.valid_cnpj(cnpj_digits) then raise exception 'CNPJ invalido'; end if;
  select id into branch_key from public.branches where code=upper(document_payload ->> 'origin_code') and active;
  if branch_key is null then raise exception 'Origem invalida'; end if;
  select * into table_row from public.price_tables
    where id=(document_payload ->> 'price_table_id')::uuid and active
      and valid_from <= current_date and (valid_to is null or valid_to >= current_date);
  if not found then raise exception 'Tabela comercial invalida'; end if;
  if table_row.destination_state is not null and table_row.destination_state <> upper(document_payload ->> 'destination_state') then raise exception 'Tabela nao atende ao destino'; end if;
  if table_row.origin_branch_id is not null and table_row.origin_branch_id <> branch_key then raise exception 'Tabela nao atende a origem'; end if;
  if not public.is_admin() and not exists(select 1 from public.profile_branch_access where profile_id=auth.uid() and branch_id=branch_key) then raise exception 'Origem nao autorizada'; end if;
  if not public.is_admin() and not exists(select 1 from public.profile_price_table_access where profile_id=auth.uid() and price_table_id=table_row.id) then raise exception 'Tabela nao autorizada'; end if;

  if document_key is null then
    insert into public.commercial_documents(document_type,seller_id,destination_state,origin_branch_id,price_table_id,price_table_code_snapshot,price_table_version_snapshot,customer_cnpj,customer_name,customer_state,notes)
    values(document_kind,auth.uid(),upper(document_payload ->> 'destination_state'),branch_key,table_row.id,table_row.code,table_row.version,nullif(cnpj_digits,''),trim(document_payload ->> 'customer_name'),nullif(upper(document_payload ->> 'customer_state'),''),nullif(document_payload ->> 'notes',''))
    returning id into document_key;
  else
    if not exists(select 1 from public.commercial_documents d where d.id=document_key and d.status='RASCUNHO' and (d.seller_id=auth.uid() or public.is_admin())) then raise exception 'Rascunho nao encontrado'; end if;
    update public.commercial_documents set document_type=document_kind,destination_state=upper(document_payload ->> 'destination_state'),origin_branch_id=branch_key,price_table_id=table_row.id,price_table_code_snapshot=table_row.code,price_table_version_snapshot=table_row.version,customer_cnpj=nullif(cnpj_digits,''),customer_name=trim(document_payload ->> 'customer_name'),customer_state=nullif(upper(document_payload ->> 'customer_state'),''),notes=nullif(document_payload ->> 'notes','') where id=document_key;
    delete from public.commercial_document_items where document_id=document_key;
  end if;

  for item in select value from jsonb_array_elements(items_payload) loop
    line_no := line_no + 1;
    requested_qty := (item ->> 'quantity')::numeric;
    if requested_qty <= 0 then raise exception 'Quantidade invalida na linha %', line_no; end if;
    select * into product_row from public.products where id=(item ->> 'product_id')::uuid and active;
    if not found then raise exception 'Produto invalido na linha %', line_no; end if;
    select * into price_row from public.product_prices pp where pp.product_id=product_row.id and pp.price_table_id=table_row.id and pp.valid_from<=now() and (pp.valid_to is null or pp.valid_to>now()) order by pp.valid_from desc limit 1;
    if not found then raise exception 'Produto sem preco na linha %', line_no; end if;
    if document_kind = 'PEDIDO' and requested_qty > coalesce((select quantity from public.branch_stock where product_id=product_row.id and branch_id=branch_key),0) then
      raise exception 'Estoque insuficiente na linha %', line_no;
    end if;
    insert into public.commercial_document_items(document_id,line_number,product_id,product_code_snapshot,description_snapshot,application_snapshot,quantity,unit_price,stock_snapshot,price_record_id)
    values(document_key,line_no,product_row.id,product_row.code,product_row.description,(select string_agg(pa.application,'; ' order by pa.application) from public.product_applications pa where pa.product_id=product_row.id),requested_qty,price_row.price,(select quantity from public.branch_stock where product_id=product_row.id and branch_id=branch_key),price_row.id);
  end loop;
  update public.commercial_documents d set subtotal=x.amount,total=x.amount from (select document_id,sum(line_total) amount from public.commercial_document_items where document_id=document_key group by document_id) x where d.id=x.document_id;
  return document_key;
end;
$$;

create or replace function public.convert_quotation_to_order(quotation_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.commercial_documents%rowtype; new_id uuid; unavailable text;
begin
  select * into q from public.commercial_documents where id=quotation_id and document_type='COTACAO' and status<>'CANCELADO' and (seller_id=auth.uid() or public.is_admin());
  if not found then raise exception 'Cotacao nao encontrada'; end if;
  select string_agg(i.product_code_snapshot, ', ') into unavailable
  from public.commercial_document_items i
  left join public.product_prices pp on pp.product_id=i.product_id and pp.price_table_id=q.price_table_id and pp.valid_from<=now() and (pp.valid_to is null or pp.valid_to>now())
  left join public.branch_stock bs on bs.product_id=i.product_id and bs.branch_id=q.origin_branch_id
  where i.document_id=q.id and (pp.id is null or coalesce(bs.quantity,0)<i.quantity);
  if unavailable is not null then raise exception 'Preco ou estoque indisponivel para: %', unavailable; end if;
  new_id := public.save_commercial_document(
    jsonb_build_object('document_type','PEDIDO','destination_state',q.destination_state,'origin_code',(select code from public.branches where id=q.origin_branch_id),'price_table_id',q.price_table_id,'customer_cnpj',q.customer_cnpj,'customer_name',q.customer_name,'customer_state',q.customer_state,'notes',q.notes),
    (select jsonb_agg(jsonb_build_object('product_id',i.product_id,'quantity',i.quantity) order by i.line_number) from public.commercial_document_items i where i.document_id=q.id)
  );
  update public.commercial_documents set source_quotation_id=q.id where id=new_id;
  return new_id;
end;
$$;

create or replace function public.set_commercial_document_status(document_id uuid, new_status public.document_status)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.commercial_documents%rowtype; generated_number text;
begin
  select * into d from public.commercial_documents where id=document_id and (seller_id=auth.uid() or public.is_admin()) for update;
  if not found then raise exception 'Documento nao encontrado'; end if;
  if new_status='GERADO' and d.status='RASCUNHO' then
    generated_number := coalesce(d.document_number,case when d.document_type='PEDIDO' then 'PED-' else 'COT-' end||lpad(nextval('public.commercial_document_number_seq')::text,8,'0'));
    update public.commercial_documents set status='GERADO',document_number=generated_number,generated_at=now() where id=d.id;
  elsif new_status='ENVIADO' and d.status='GERADO' then update public.commercial_documents set status='ENVIADO',sent_at=now() where id=d.id; generated_number:=d.document_number;
  elsif new_status='CANCELADO' and d.status in ('RASCUNHO','GERADO','ENVIADO') then update public.commercial_documents set status='CANCELADO',cancelled_at=now() where id=d.id; generated_number:=d.document_number;
  else raise exception 'Transicao de status invalida'; end if;
  return generated_number;
end;
$$;

create or replace function public.set_profile_access(target_profile_id uuid, branch_ids uuid[], price_table_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem alterar acessos'; end if;
  if not exists(select 1 from public.profiles where id=target_profile_id) then raise exception 'Perfil nao encontrado'; end if;

  delete from public.profile_branch_access where profile_id=target_profile_id;
  insert into public.profile_branch_access(profile_id,branch_id)
  select target_profile_id, value
  from (select distinct unnest(coalesce(branch_ids,'{}'::uuid[])) as value) selected;

  delete from public.profile_price_table_access where profile_id=target_profile_id;
  insert into public.profile_price_table_access(profile_id,price_table_id)
  select target_profile_id, value
  from (select distinct unnest(coalesce(price_table_ids,'{}'::uuid[])) as value) selected;
end;
$$;

create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind; version_key uuid; sync_key uuid; row_data jsonb; product_key uuid; table_key uuid; branch_key uuid; applied integer:=0; apps jsonb;
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem importar'; end if;
  if jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)=0 then raise exception 'Lote vazio'; end if;
  insert into public.catalog_versions(kind,label,source_name,row_count,is_active,created_by) values(import_kind_value,import_kind_value::text||' '||to_char(now(),'YYYY-MM-DD HH24:MI'),source_name,jsonb_array_length(rows),false,auth.uid()) returning id into version_key;
  insert into public.sync_metadata(source_kind,import_kind,source_name,rows_received,version_id,started_by)
  values(case when source_name like 'onedrive:%' then 'ONEDRIVE' else 'MANUAL' end,import_kind_value,source_name,jsonb_array_length(rows),version_key,auth.uid())
  returning id into sync_key;
  begin
    for row_data in select value from jsonb_array_elements(rows) loop
      if import_kind_value in ('PRODUTOS','COMPLETO') then
        if nullif(trim(row_data->>'code'),'') is null or nullif(trim(row_data->>'description'),'') is null then raise exception 'Codigo e descricao sao obrigatorios'; end if;
        insert into public.products(code,description,category,product_line,synonyms,search_text,catalog_version_id)
        values(trim(row_data->>'code'),trim(row_data->>'description'),nullif(trim(row_data->>'category'),''),nullif(trim(row_data->>'product_line'),''),coalesce(array(select jsonb_array_elements_text(coalesce(row_data->'synonyms','[]'::jsonb))),'{}'),public.normalize_search(concat_ws(' ',row_data->>'code',row_data->>'description',row_data->>'category',row_data->>'product_line',row_data->>'synonyms')),version_key)
        on conflict(code) do update set description=excluded.description,category=excluded.category,product_line=excluded.product_line,synonyms=excluded.synonyms,search_text=excluded.search_text,catalog_version_id=version_key,active=true
        returning id into product_key;
        if row_data ? 'applications' then
          delete from public.product_applications where product_id=product_key;
          for apps in select value from jsonb_array_elements(coalesce(row_data->'applications','[]'::jsonb)) loop
            insert into public.product_applications(product_id,vehicle,model,application,search_text) values(product_key,nullif(apps->>'vehicle',''),nullif(apps->>'model',''),coalesce(nullif(apps->>'application',''),apps#>>'{}'),public.normalize_search(concat_ws(' ',apps->>'vehicle',apps->>'model',coalesce(apps->>'application',apps#>>'{}')))) on conflict do nothing;
          end loop;
        end if;
      else
        select id into product_key from public.products where code=trim(row_data->>'code');
        if product_key is null then raise exception 'Produto nao encontrado: %',row_data->>'code'; end if;
      end if;
      if import_kind_value in ('PRECOS','COMPLETO') and row_data ? 'price' then
        select id into table_key from public.price_tables where (id::text=row_data->>'price_table_id' or code=row_data->>'price_table_code') and active order by version desc limit 1;
        if table_key is null then raise exception 'Tabela de preco nao encontrada'; end if;
        update public.product_prices set valid_to=now() where product_id=product_key and price_table_id=table_key and valid_to is null;
        insert into public.product_prices(product_id,price_table_id,price,commercial_version_id) values(product_key,table_key,(row_data->>'price')::numeric,version_key);
      end if;
      if import_kind_value in ('ESTOQUE','COMPLETO') and row_data ? 'quantity' then
        select id into branch_key from public.branches where code=upper(row_data->>'origin_code');
        if branch_key is null then raise exception 'Filial nao encontrada'; end if;
        insert into public.branch_stock(product_id,branch_id,quantity,commercial_version_id) values(product_key,branch_key,(row_data->>'quantity')::numeric,version_key) on conflict(product_id,branch_id) do update set quantity=excluded.quantity,commercial_version_id=version_key,updated_at=now();
      end if;
      applied:=applied+1;
    end loop;
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

create or replace function public.storage_summary()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_admin() then jsonb_build_object(
    'database_bytes',pg_database_size(current_database()),
    'tables',coalesce((select jsonb_object_agg(relname,total_bytes) from (select c.relname,pg_total_relation_size(c.oid) total_bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') x),'{}'::jsonb),
    'products',(select count(*) from public.products),
    'documents',(select count(*) from public.commercial_documents),
    'last_sync',(select max(finished_at) from public.sync_metadata where status='CONCLUIDO')
  ) else null end;
$$;

revoke all on all tables in schema public from public, anon;
revoke all on all sequences in schema public from public, anon;
revoke all on all functions in schema public from public, anon;
revoke execute on function public.handle_new_auth_user() from authenticated;
revoke all on public.commercial_documents, public.commercial_document_items from authenticated;

grant usage on schema public to authenticated;
grant select on public.profiles,public.catalog_versions,public.branches,public.products,public.product_applications,public.price_tables,public.product_prices,public.branch_stock,public.profile_price_table_access,public.profile_branch_access,public.commercial_documents,public.commercial_document_items,public.sync_metadata,public.drive_integration_settings to authenticated;
grant insert,update,delete on public.catalog_versions,public.branches,public.products,public.product_applications,public.price_tables,public.product_prices,public.branch_stock,public.profile_price_table_access,public.profile_branch_access,public.sync_metadata,public.drive_integration_settings to authenticated;
grant update on public.profiles to authenticated;
grant usage,select on sequence public.commercial_document_number_seq to authenticated;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer) to authenticated;
grant execute on function public.save_commercial_document(jsonb,jsonb) to authenticated;
grant execute on function public.convert_quotation_to_order(uuid) to authenticated;
grant execute on function public.set_commercial_document_status(uuid,public.document_status) to authenticated;
grant execute on function public.set_profile_access(uuid,uuid[],uuid[]) to authenticated;
grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated;
grant execute on function public.storage_summary() to authenticated;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.is_admin() to authenticated;

commit;
