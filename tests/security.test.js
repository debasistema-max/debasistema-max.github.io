import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const publicFiles = [
  'index.html',
  'src/main.js',
  'src/styles.css',
  'src/config.js',
  'src/services/api.js',
  'src/lib/exporters.js'
];

describe('exposição pública', () => {
  it('não contém marcas externas nas telas ou metadados', () => {
    const content = publicFiles.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
    const forbidden = [
      ['I', 'P', 'S', ' do Brasil'].join(''),
      ['Yoko', 'mitsu'].join(''),
      ['R', 'T', ' Group'].join(''),
      ['crm', '-autopecas'].join('')
    ];
    forbidden.forEach((term) => assert.equal(content.toLowerCase().includes(term.toLowerCase()), false));
  });

  it('não envia segredos administrativos ao frontend', () => {
    const content = publicFiles.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
    assert.doesNotMatch(content, /service_role|MS_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('contratos de autorização', () => {
  it('busca o perfil somente para o usuário autenticado', () => {
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(api, /\.eq\('id', session\.user\.id\)\s*\.single\(\)/);
  });

  it('restringe estoques e validade da tabela na busca privilegiada', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0001_initial.sql', import.meta.url), 'utf8');
    assert.match(migration, /pt\.active\s+and pt\.valid_from <= current_date/);
    assert.match(migration, /profile_branch_access a where a\.profile_id=auth\.uid\(\) and a\.branch_id=b\.id/);
    assert.match(migration, /set_profile_access\(target_profile_id uuid, branch_ids uuid\[\], price_table_ids uuid\[\]\)/);
  });

  it('permite reexportar documentos salvos sem armazenar arquivos', () => {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(main, /data-export-document/);
    assert.match(main, /handleSavedDocumentExport/);
    assert.match(api, /async getDocument\(id\)/);
  });

  it('mantém convites de usuário em função backend restrita a ADMIN', () => {
    const edgeFunction = readFileSync(new URL('../supabase/functions/admin-users/index.ts', import.meta.url), 'utf8');
    assert.match(edgeFunction, /await requireAdmin\(req\)/);
    assert.match(edgeFunction, /inviteUserByEmail/);
    assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
    const frontend = publicFiles.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
    assert.doesNotMatch(frontend, /SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('entrega fotos somente por função autenticada e mantém a origem fora do frontend', () => {
    const edgeFunction = readFileSync(new URL('../supabase/functions/product-image/index.ts', import.meta.url), 'utf8');
    const frontend = publicFiles.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
    assert.match(edgeFunction, /await requireUser\(req\)/);
    assert.match(edgeFunction, /PRODUCT_IMAGE_ORIGIN/);
    assert.match(edgeFunction, /Cache-Control.*private/);
    assert.doesNotMatch(frontend, /PRODUCT_IMAGE_ORIGIN|uploads\/products/);
  });

  it('gera listas completas paginadas e permite seleção personalizada', () => {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(main, /data-list-product/);
    assert.match(main, /state\.listSelection/);
    assert.match(main, /api\.searchAllProducts/);
    assert.match(api, /async searchAllProducts\(params/);
    assert.match(api, /select\('category,product_line'\)\.eq\('active', true\)/);
    assert.doesNotMatch(api, /select\('category,product_line,price/);
  });

  it('mantém a inativação em lote entre sincronizações e oculta os itens comercialmente', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0010_bulk_product_activation.sql', import.meta.url), 'utf8');
    const syncMigration = readFileSync(new URL('../supabase/migrations/0009_state_commercial_price_rules.sql', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(migration, /admin_inactive boolean not null default false/);
    assert.match(migration, /where p\.active and not p\.admin_inactive/);
    assert.match(migration, /admin_set_products_active\(product_ids uuid\[\], new_active boolean\)/);
    assert.match(migration, /Apenas administradores podem gerenciar produtos/);
    assert.doesNotMatch(syncMigration, /admin_inactive\s*=/);
    assert.match(main, /data-admin-product/);
    assert.match(main, /Inativar selecionados/);
    assert.match(main, /Reativar selecionados/);
    assert.match(api, /admin_list_products/);
    assert.match(api, /admin_set_products_active/);
    assert.match(api, /\.eq\('admin_inactive', false\)/);
    const imageFunction = readFileSync(new URL('../supabase/functions/product-image/index.ts', import.meta.url), 'utf8');
    assert.match(imageFunction, /\.eq\("admin_inactive", false\)/);
  });

  it('registra diferenças por sincronização com acesso administrativo e retenção limitada', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0012_sync_change_history.sql', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(migration, /create table if not exists public\.sync_item_changes/);
    assert.match(migration, /sync_item_changes_admin_read[\s\S]*public\.is_admin\(\)/);
    assert.match(migration, /limit 20/);
    assert.match(migration, /old\.quantity is distinct from new\.quantity/);
    assert.match(migration, /previous_price is distinct from new\.price/);
    assert.match(migration, /Aplicação \/ Ano/);
    assert.match(migration, /admin_list_sync_runs\(max_runs integer default 12\)/);
    assert.match(migration, /admin_list_sync_changes\(/);
    assert.match(main, /Alterações por sincronização/);
    assert.match(main, /data-sync-run/);
    assert.match(api, /async listSyncRuns\(/);
    assert.match(api, /async listSyncChanges\(/);
  });

  it('processa auditoria de preços em lote para evitar timeout', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0013_bulk_price_sync_audit.sql', import.meta.url), 'utf8');
    assert.match(migration, /bulk_price_audit/);
    assert.match(migration, /insert into public\.sync_item_changes\([\s\S]*current_price\.price is distinct from incoming_rows\.new_price/);
    assert.match(migration, /insert into public\.product_prices\(product_id,price_table_id,price,commercial_version_id\)[\s\S]*jsonb_array_elements\(rows\)/);
    assert.match(migration, /import_kind_value <> 'PRECOS'/);
    assert.match(migration, /import_catalog_batch_legacy/);
  });

  it('prepara snapshot de preços uma vez e evita comparação quadrática', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0014_stage_price_sync.sql', import.meta.url), 'utf8');
    assert.match(migration, /create temporary table debaportal_price_import/);
    assert.match(migration, /create index debaportal_price_import_key_idx/);
    assert.match(migration, /left join pg_temp\.debaportal_price_import staged/);
    assert.doesNotMatch(migration, /not exists \([\s\S]*jsonb_array_elements\(rows\)/);
    assert.match(migration, /set statement_timeout = '60s'/);
  });
});
