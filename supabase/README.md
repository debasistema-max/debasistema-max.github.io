# Supabase do DebaPortal

Esta pasta pertence a um projeto Supabase novo e independente. Não aplique estas
migrações em outro projeto.

## Aplicação segura

1. Crie um projeto Supabase exclusivo e registre URL, região e plano escolhido.
2. No SQL Editor do projeto novo, execute `migrations/0001_initial.sql` uma vez.
3. Crie o primeiro usuário pelo painel de Auth. O gatilho cria o perfil inativo.
4. Promova o primeiro administrador pelo SQL Editor, usando o UUID real:

   ```sql
   update public.profiles
   set role = 'ADMIN', active = true
   where id = '<uuid-do-primeiro-usuario>';
   ```

5. Cadastre filiais e tabelas comerciais. Depois associe vendedores em
   `profile_branch_access` e `profile_price_table_access`.
6. Rode `tests/001_schema_security_smoke.sql` em banco local ou descartável.

Não há dados comerciais, chaves ou tokens nesta migração. Usuários novos ficam
inativos até aprovação administrativa. O frontend usa somente a chave pública
`anon`; a chave `service_role` nunca deve ser enviada ao navegador.

## RPCs do frontend

- `search_catalog(search_text, destination_state, origin_code, price_table_id,
  category_filter, line_filter, in_stock_only, page_number, page_size)` retorna
  catálogo paginado, preço autorizado e estoques PR/SP.
- `save_commercial_document(document_payload, items_payload)` grava ou atualiza
  um rascunho e recalcula preços no servidor. O payload de itens contém somente
  `product_id` e `quantity`.
- `convert_quotation_to_order(quotation_id)` revalida preço e estoque e cria um
  pedido em rascunho.
- `set_profile_access(target_profile_id, branch_ids, price_table_ids)` substitui
  os acessos de um vendedor; somente ADMIN.
- `import_catalog_batch(import_kind, source_name, rows)` aceita `PRODUTOS`,
  `PRECOS`, `ESTOQUE` ou `COMPLETO`; somente ADMIN.
- `storage_summary()` retorna uso estimado e contagens; somente ADMIN recebe dados.

## OneDrive

`drive_integration_settings` armazena apenas identificadores não secretos. Tokens,
client secret e refresh token devem permanecer em secrets de Edge Functions. A
função `sync-onedrive` verifica a fonte autorizada sem baixar a planilha completa.

A carga comercial online usa uma solicitação registrada por `sync-onedrive` e o
workflow `.github/workflows/sync-catalog.yml`. O executor recebe somente o ID da
solicitação, baixa o arquivo por URL temporária e chama `import_catalog_batch`.
As chaves permanecem nos secrets e o fluxo exige `0004_service_executor.sql` e
`0006_on_demand_sync_jobs.sql`. O script local continua disponível como contingência.

## Armazenamento

O catálogo atual é atualizado por chave, sem copiar o produto a cada versão.
Versões guardam metadados, preços usam vigência temporal e documentos preservam
somente os snapshots necessários. PDFs e XLSX gerados não são persistidos.

Monitore `storage_summary()` e configure backups no painel do projeto conforme o
plano contratado. Confirme os limites atuais no painel do Supabase antes de usar
dados reais.

Em 4 de novembro de 2026, a documentação oficial informa para o plano Free:

- no máximo dois projetos gratuitos ativos, contabilizados entre organizações em
  que a pessoa é Owner ou Administrator;
- 500 MB de tamanho de banco por projeto;
- pausa após uma semana de inatividade;
- ausência de backup automático incluído.

Fontes: `https://supabase.com/docs/guides/platform/billing-on-supabase` e
`https://supabase.com/pricing`.

O disco técnico do projeto Free pode ser maior que a cota de banco. Para este
projeto, use os 500 MB como limite comercial efetivo e trate 400 MB como alerta.
Não presuma que há uma vaga gratuita disponível: confirme a organização e os
projetos ativos antes de criar o projeto. Se backups automáticos não fizerem parte
do plano escolhido, defina um procedimento externo autorizado de `pg_dump` e
teste a restauração em ambiente descartável.
