create table if not exists public.product_images (
  product_id uuid primary key references public.products(id) on delete cascade,
  image_path text not null,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  constraint product_images_path_check check (
    length(image_path) <= 500
    and image_path ~* '^/uploads/products/[A-Za-z0-9._-]+/site/[A-Za-z0-9._-]+[.](webp|png|jpe?g)$'
    and position('..' in image_path) = 0
  )
);

alter table public.product_images enable row level security;
revoke all on public.product_images from public, anon, authenticated;
grant all on public.product_images to service_role;

create or replace function public.sync_product_images(source_name text, rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_data jsonb;
  product_key uuid;
  incoming_count integer := 0;
  applied_count integer := 0;
  skipped_count integer := 0;
  removed_count integer := 0;
  code_value text;
  path_value text;
  updated_value timestamptz;
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem sincronizar fotos'; end if;
  if nullif(trim(source_name),'') is null then raise exception 'Origem da sincronizacao obrigatoria'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then raise exception 'Lote de fotos vazio'; end if;
  if jsonb_array_length(rows) > 10000 then raise exception 'Lote de fotos excede o limite'; end if;

  create temporary table incoming_product_images (
    product_id uuid primary key,
    image_path text not null,
    source_updated_at timestamptz
  ) on commit drop;

  for row_data in select value from jsonb_array_elements(rows) loop
    incoming_count := incoming_count + 1;
    code_value := trim(coalesce(row_data->>'code',''));
    path_value := trim(coalesce(row_data->>'image_path',''));
    if code_value !~ '^[A-Za-z0-9._-]{1,100}$' then raise exception 'Codigo de foto invalido'; end if;
    if path_value !~* '^/uploads/products/[A-Za-z0-9._-]+/site/[A-Za-z0-9._-]+[.](webp|png|jpe?g)$'
      or position('..' in path_value) > 0 then raise exception 'Caminho de foto invalido'; end if;
    updated_value := case
      when nullif(row_data->>'source_updated_at','') is null then null
      else (row_data->>'source_updated_at')::timestamptz
    end;

    select id into product_key from public.products where code = code_value and active;
    if product_key is null then
      skipped_count := skipped_count + 1;
      continue;
    end if;
    insert into incoming_product_images(product_id,image_path,source_updated_at)
    values(product_key,path_value,updated_value)
    on conflict(product_id) do update set
      image_path=excluded.image_path,source_updated_at=excluded.source_updated_at;
  end loop;

  insert into public.product_images(product_id,image_path,source_updated_at,synced_at)
  select product_id,image_path,source_updated_at,now() from incoming_product_images
  on conflict(product_id) do update set
    image_path=excluded.image_path,source_updated_at=excluded.source_updated_at,synced_at=excluded.synced_at;
  get diagnostics applied_count = row_count;

  delete from public.product_images stored
  where not exists (select 1 from incoming_product_images incoming where incoming.product_id=stored.product_id);
  get diagnostics removed_count = row_count;

  return jsonb_build_object(
    'ok',true,
    'rows_received',incoming_count,
    'rows_applied',applied_count,
    'rows_skipped',skipped_count,
    'rows_removed',removed_count
  );
end;
$$;

revoke all on function public.sync_product_images(text,jsonb) from public, anon;
grant execute on function public.sync_product_images(text,jsonb) to authenticated, service_role;
