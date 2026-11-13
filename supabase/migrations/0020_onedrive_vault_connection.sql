create extension if not exists supabase_vault with schema vault;

create or replace function public.backend_get_onedrive_refresh_token()
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare token_value text;
begin
  if auth.role() <> 'service_role' then raise exception 'Acesso de backend obrigatório'; end if;
  select decrypted_secret into token_value from vault.decrypted_secrets
  where name = 'debaportal.onedrive.refresh_token' order by updated_at desc limit 1;
  return token_value;
end;
$$;

create or replace function public.backend_set_onedrive_refresh_token(token_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare secret_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Acesso de backend obrigatório'; end if;
  if token_value is null or length(token_value) < 40 or length(token_value) > 4096 then
    raise exception 'Token Microsoft inválido';
  end if;
  select id into secret_id from vault.secrets
  where name = 'debaportal.onedrive.refresh_token' order by updated_at desc limit 1;
  if secret_id is null then
    perform vault.create_secret(token_value, 'debaportal.onedrive.refresh_token', 'Token delegado exclusivo do DebaPortal');
  else
    perform vault.update_secret(secret_id, token_value, 'debaportal.onedrive.refresh_token', 'Token delegado exclusivo do DebaPortal');
  end if;
end;
$$;

revoke all on function public.backend_get_onedrive_refresh_token() from public, anon, authenticated;
revoke all on function public.backend_set_onedrive_refresh_token(text) from public, anon, authenticated;
grant execute on function public.backend_get_onedrive_refresh_token() to service_role;
grant execute on function public.backend_set_onedrive_refresh_token(text) to service_role;
