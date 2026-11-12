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

  it('aceita os formatos atuais de foto e tenta o caminho padrão para todo código numérico', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0015_product_image_paths.sql', import.meta.url), 'utf8');
    const edgeFunction = readFileSync(new URL('../supabase/functions/product-image/index.ts', import.meta.url), 'utf8');
    assert.match(migration, /\(site\/\)\?/);
    assert.match(edgeFunction, /FALLBACK_CODE_PATTERN/);
    assert.match(edgeFunction, /\(\?:site\\\/\)\?/);
    assert.match(edgeFunction, /image\?\.image_path/);
    assert.match(edgeFunction, /for \(const extension of \["webp", "png", "jpg"\]\)/);
    assert.match(edgeFunction, /for \(const imagePath of candidates\)/);
  });

  it('permite atualizar fotos somente pelo site com acompanhamento administrativo', () => {
    const syncFunction = readFileSync(new URL('../supabase/functions/sync-onedrive/index.ts', import.meta.url), 'utf8');
    const photoScript = readFileSync(new URL('../scripts/sync-photos-remote.mjs', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../.github/workflows/sync-catalog.yml', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(syncFunction, /dispatch_photos/);
    assert.match(syncFunction, /photos_only: "true"/);
    assert.match(photoScript, /status: "EM_EXECUCAO"/);
    assert.match(photoScript, /status: "CONCLUIDO"/);
    assert.match(workflow, /SYNC_JOB_ID:.*inputs\.job_id/);
    assert.match(main, /Atualizar fotos pelo site/);
    assert.match(main, /photoCache\.delete\(code\)/);
  });

  it('baixa a planilha no momento da execução sem expor link temporário', () => {
    const syncFunction = readFileSync(new URL('../supabase/functions/sync-onedrive/index.ts', import.meta.url), 'utf8');
    const syncScript = readFileSync(new URL('../scripts/sync-onedrive-remote.mjs', import.meta.url), 'utf8');
    assert.match(syncFunction, /input\.action === "download"/);
    assert.match(syncFunction, /hasServiceRole\(req\)/);
    assert.match(syncFunction, /from\("sync_jobs"\)\.select\("id", \{ head: true \}\)/);
    assert.match(syncFunction, /Cache-Control": "no-store"/);
    assert.match(syncFunction, /redirect: "follow"/);
    assert.match(syncScript, /functions\/v1\/sync-onedrive/);
    assert.match(syncScript, /action: "download"/);
    assert.doesNotMatch(syncScript, /job\.source_download_url/);
  });

  it('gera listas completas paginadas e permite seleção personalizada', () => {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(main, /data-list-product/);
    assert.match(main, /state\.listSelection/);
    assert.match(main, /api\.searchAllProducts/);
    assert.match(api, /async searchAllProducts\(params/);
    assert.match(api, /select\('category,product_line,commercial_line'\)\.eq\('active', true\)/);
    assert.doesNotMatch(api, /select\('category,product_line,commercial_line,price/);
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

  it('remove aplicações e anos duplicados antes de montar listas comerciais', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0016_deduplicate_commercial_list.sql', import.meta.url), 'utf8');
    assert.match(migration, /row_number\(\) over/);
    assert.match(migration, /product_applications_product_application_year_normalized_key/);
    assert.match(migration, /rename to search_catalog_raw/);
    assert.match(migration, /group by public\.normalize_search\(application_value\)/);
    assert.match(migration, /group by public\.normalize_search\(year_value\)/);
    assert.match(migration, /revoke all on function public\.search_catalog_raw/);
  });

  it('restaura o nome esperado internamente pela consulta do catálogo', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0017_restore_search_catalog.sql', import.meta.url), 'utf8');
    assert.match(migration, /drop function if exists public\.search_catalog/);
    assert.match(migration, /alter function public\.search_catalog_raw/);
    assert.match(migration, /rename to search_catalog/);
    assert.match(migration, /grant execute[\s\S]*to authenticated/);
  });

  it('aceita múltiplas categorias e linhas sem ampliar o acesso ao catálogo', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0018_multi_select_catalog_filters.sql', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(migration, /p\.category = any\(string_to_array\(category_filter, chr\(31\)\)\)/);
    assert.match(migration, /p\.product_line = any\(string_to_array\(line_filter, chr\(31\)\)\)/);
    assert.match(migration, /if not public\.is_active_user\(\) then raise exception/);
    assert.match(migration, /revoke all on function public\.search_catalog[\s\S]*from public,anon/);
    assert.match(api, /encodeFilterSelection\(params\.category\)/);
    assert.match(api, /encodeFilterSelection\(params\.line\)/);
  });

  it('separa linha comercial e marca mantendo os filtros protegidos', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0019_product_brand_and_commercial_line.sql', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(migration, /add column if not exists commercial_line text/);
    assert.match(migration, /commercial_line in \('Leve', 'Pesada', 'Utilitário'\)/);
    assert.match(migration, /p\.commercial_line = any\(string_to_array\(line_filter, chr\(31\)\)\)/);
    assert.match(migration, /p\.product_line = any\(string_to_array\(brand_filter, chr\(31\)\)\)/);
    assert.match(migration, /if not public\.is_active_user\(\) then raise exception/);
    assert.match(api, /brand_filter: encodeFilterSelection\(params\.brand\)/);
  });
});
