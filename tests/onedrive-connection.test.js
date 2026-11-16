import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('reconexão segura do OneDrive', () => {
  it('guarda o refresh token no Vault e limita acesso ao backend', () => {
    const migration = readFileSync(new URL('../supabase/migrations/0020_onedrive_vault_connection.sql', import.meta.url), 'utf8');
    assert.match(migration, /vault\.create_secret/);
    assert.match(migration, /vault\.update_secret/);
    assert.match(migration, /revoke all on function public\.backend_get_onedrive_refresh_token\(\) from public, anon, authenticated/);
    assert.match(migration, /grant execute on function public\.backend_set_onedrive_refresh_token\(text\) to service_role/);
  });

  it('conclui device code no backend sem devolver tokens ao navegador', () => {
    const syncFunction = readFileSync(new URL('../supabase/functions/sync-onedrive/index.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(syncFunction, /connect_start/);
    assert.match(syncFunction, /connect_complete/);
    assert.match(syncFunction, /authorization_pending/);
    assert.match(syncFunction, /backend_set_onedrive_refresh_token/);
    assert.match(syncFunction, /\["microsoft\.com", "www\.microsoft\.com"\]/);
    assert.match(syncFunction, /\["\/devicelogin", "\/link"\]/);
    assert.doesNotMatch(main, /refresh_token/);
    assert.match(main, /Reconectar OneDrive/);
    assert.match(main, /Confirmar conexão/);
    assert.match(api, /response\.clone\(\)\.json\(\)/);
    assert.match(api, /throw await invocationError\(error\)/);
  });

  it('atualiza somente a matriz configurada após criar backup', () => {
    const syncFunction = readFileSync(new URL('../supabase/functions/sync-onedrive/index.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(syncFunction, /offline_access Files\.ReadWrite/);
    assert.match(syncFunction, /input\.action === "patch_matrix"/);
    assert.match(syncFunction, /rows\.length > 200/);
    assert.match(syncFunction, /requiredEnv\("ONEDRIVE_FOLDER_PATH"\)/);
    assert.match(syncFunction, /requiredEnv\("ONEDRIVE_WORKBOOK_NAME"\)/);
    assert.match(syncFunction, /const backupName = await createWorkbookBackup\(token, target\)/);
    assert.match(syncFunction, /monitor\.hostname === "onedrive\.com"/);
    assert.match(syncFunction, /monitor\.hostname === "my\.microsoftpersonalcontent\.com"/);
    assert.match(syncFunction, /\/\\\/monitor\\\//);
    assert.match(syncFunction, /workbook\/worksheets\/\$\{sheetName\}\/range/);
    assert.ok(syncFunction.indexOf('await createWorkbookBackup(token, target)') < syncFunction.indexOf('https://graph.microsoft.com/v1.0/$batch'));
    assert.match(api, /body: \{ action: 'patch_matrix', rows \}/);
    assert.ok(main.indexOf('await api.patchMatrixOneDrive') < main.indexOf("await api.importRows('catalog', `partial-matrix:"));
    assert.match(main, /Reconectar OneDrive/);
  });
});
