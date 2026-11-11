-- Contexto comercial minimo para a planilha mestre autorizada.
-- Nao copia dados do CRM e nao altera a planilha de origem.

begin;

insert into public.branches(code, name, state, active)
values
  ('PR', 'Origem PR', 'PR', true),
  ('SP', 'Origem SP', 'SP', true)
on conflict (code) do update
set name = excluded.name,
    state = excluded.state,
    active = true;

insert into public.price_tables(code, name, version, destination_state, origin_branch_id, valid_from, active)
select route.code, route.name, 1, route.destination_state, branch.id, current_date, true
from (values
  ('PR-PR', 'Tabela PR para PR', 'PR', 'PR'),
  ('SP-SP', 'Tabela SP para SP', 'SP', 'SP'),
  ('PR-SC', 'Tabela PR para SC', 'SC', 'PR'),
  ('PR-SP', 'Tabela PR para SP', 'SP', 'PR')
) as route(code, name, destination_state, origin_code)
join public.branches branch on branch.code = route.origin_code
on conflict (code, version) do update
set name = excluded.name,
    destination_state = excluded.destination_state,
    origin_branch_id = excluded.origin_branch_id,
    active = true;

insert into public.drive_integration_settings(id, provider, enabled)
values (true, 'ONEDRIVE', true)
on conflict (id) do update
set provider = excluded.provider,
    enabled = true,
    updated_at = now();

commit;
