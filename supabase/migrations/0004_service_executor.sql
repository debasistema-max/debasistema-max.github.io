-- Permite que um executor backend com a chave service_role use as mesmas
-- rotinas administrativas. A chave nunca deve ser enviada ao frontend.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.role() = 'service_role'
    or exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and active
        and role = 'ADMIN'
    );
$$;

grant execute on function public.import_catalog_batch(text, text, jsonb) to service_role;
grant execute on function public.storage_summary() to service_role;
