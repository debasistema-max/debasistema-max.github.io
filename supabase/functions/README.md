# Funcoes do DebaPortal

Estas funcoes pertencem ao projeto Supabase exclusivo do DebaPortal. Nao as publique em outro projeto.

## Funcoes

- `consulta-cnpj`: exige JWT valido, valida os digitos verificadores e consulta BrasilAPI com fallback para ReceitaWS. A resposta nao e gravada como cliente.
- `sync-onedrive`: valida ADMIN, cria uma solicitação protegida e dispara o workflow remoto somente quando o portal solicitar.
- `admin-users`: exige perfil ADMIN e envia convite pelo Supabase Auth. A chave administrativa permanece somente no ambiente seguro da Edge Function.

## Planilha comercial atual

A fonte autorizada e uma planilha OneDrive Personal. A funcao gera uma URL temporaria que fica em tabela inacessivel ao navegador. O workflow valida todas as abas antes de gravar e envia somente produtos, precos e estoque normalizados. A aba de estoque SP pode estar vazia; nesse caso, nenhum saldo SP e inventado ou gravado como zero.

O fluxo completo requer `0004_service_executor.sql` e `0006_on_demand_sync_jobs.sql`. A chave `service_role` fica somente nos secrets do workflow e nunca e enviada ao GitHub Pages.

## Segredos e configuracao da funcao Edge

Defina no projeto Supabase do DebaPortal:

```text
ALLOWED_ORIGINS=https://debasistema-max.github.io
ALLOW_LOCALHOST=false
APP_URL=https://debasistema-max.github.io
MS_GRAPH_CLIENT_ID=<aplicativo Microsoft autorizado>
MS_GRAPH_REFRESH_TOKEN=<refresh token delegado>
MS_GRAPH_SCOPE=offline_access Files.Read
ONEDRIVE_FOLDER_PATH=<pasta exata autorizada>
ONEDRIVE_WORKBOOK_NAME=<arquivo exato autorizado>
GITHUB_SYNC_TOKEN=<token com Actions write no repositorio>
GITHUB_SYNC_REPOSITORY=debasistema-max/debasistema-max.github.io
GITHUB_SYNC_WORKFLOW=sync-catalog.yml
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` sao fornecidas pelo ambiente das Edge Functions. O workflow recebe sua propria copia protegida de `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Nunca copie chaves ou segredos para o frontend, arquivos versionados ou logs.

O aplicativo Microsoft usa somente `Files.Read` delegado. A funcao aceita apenas a pasta e o arquivo configurados nos secrets; a requisicao do navegador nao pode substituir esses alvos.

## Contrato da solicitacao

Uma requisicao `POST` autenticada por ADMIN com `{ "action": "dispatch" }` cria a solicitacao e retorna:

```json
{
  "data": {
    "queued": true,
    "job_id": "uuid-da-solicitacao",
    "status": "SOLICITADO"
  }
}
```

A funcao nao carrega o XLSX em memoria. Ela registra um link temporario protegido e dispara o workflow. O portal consulta `get_sync_job` ate receber `CONCLUIDO` ou `FALHOU`.

## Publicacao futura

Somente depois de criar o Supabase independente, aplicar as migracoes revisadas e configurar os segredos:

```powershell
supabase functions deploy consulta-cnpj --project-ref REF_DO_DEBAPORTAL
supabase functions deploy sync-onedrive --project-ref REF_DO_DEBAPORTAL
supabase functions deploy admin-users --project-ref REF_DO_DEBAPORTAL
```

Nao execute esses comandos em outro projeto. Mantenha a verificacao JWT habilitada e teste primeiro em um projeto descartavel ou de homologacao do DebaPortal.
