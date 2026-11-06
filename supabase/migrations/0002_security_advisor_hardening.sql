-- DebaPortal - ajustes apontados pelo Security Advisor do Supabase.
-- Mantem as RPCs comerciais SECURITY DEFINER, pois todas validam sessao e permissao.

begin;

alter function public.normalize_search(text)
  set search_path = public, pg_temp;

alter function public.valid_cnpj(text)
  set search_path = public, pg_temp;

revoke execute on function public.handle_new_auth_user() from authenticated, anon;

create schema if not exists extensions;
alter extension pg_trgm set schema extensions;

commit;
