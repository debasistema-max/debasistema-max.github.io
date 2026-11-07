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
});
