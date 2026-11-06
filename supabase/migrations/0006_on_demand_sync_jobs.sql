create table if not exists public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references public.profiles(id) on delete set null,
  status text not null default 'SOLICITADO' check (status in ('SOLICITADO','EM_EXECUCAO','CONCLUIDO','FALHOU')),
  source_size bigint check (source_size is null or source_size > 0),
  source_modified timestamptz,
  source_download_url text,
  github_run_id bigint,
  github_run_url text,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists sync_jobs_requested_idx on public.sync_jobs(requested_at desc);
alter table public.sync_jobs enable row level security;
revoke all on public.sync_jobs from public, anon, authenticated;
grant all on public.sync_jobs to service_role;

create or replace function public.get_sync_job(sync_job_id uuid default null)
returns table (
  id uuid,
  status text,
  source_modified timestamptz,
  github_run_url text,
  summary jsonb,
  error_message text,
  requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem consultar sincronizacoes'; end if;
  return query
  select j.id, j.status, j.source_modified, j.github_run_url, j.summary,
    j.error_message, j.requested_at, j.started_at, j.finished_at
  from public.sync_jobs j
  where sync_job_id is null or j.id = sync_job_id
  order by j.requested_at desc
  limit 1;
end;
$$;

revoke all on function public.get_sync_job(uuid) from public, anon;
grant execute on function public.get_sync_job(uuid) to authenticated, service_role;
