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
    assert.match(syncFunction, /connect_start/);
    assert.match(syncFunction, /connect_complete/);
    assert.match(syncFunction, /authorization_pending/);
    assert.match(syncFunction, /backend_set_onedrive_refresh_token/);
    assert.doesNotMatch(main, /refresh_token/);
    assert.match(main, /Reconectar OneDrive/);
    assert.match(main, /Confirmar conexão/);
  });
});
