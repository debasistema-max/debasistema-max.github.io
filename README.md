# DebaPortal

Aplicação comercial independente com pedidos, cotações, listas comerciais, consulta de item e administração.

## Executar localmente

Requisitos: Node.js 22 e um projeto Supabase exclusivo.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Preencha em `.env.local` somente a URL do novo projeto, a chave pública `anon` e a URL da Edge Function de CNPJ. Nunca use `service_role`, client secret ou token do OneDrive no frontend.

Para testar a interface sem dados reais, defina temporariamente `VITE_ENABLE_DEMO=true`. O modo de demonstração usa registros fictícios em memória e não salva dados.

## Configurar o Supabase

1. Crie um projeto novo, separado de qualquer outro sistema.
2. No SQL Editor, aplique `supabase/migrations/0001_initial.sql` somente após revisão.
3. Crie o primeiro usuário no Supabase Auth.
4. Promova esse usuário conforme o comando documentado em `supabase/README.md`.
5. Crie as filiais e tabelas comerciais antes da primeira importação.
6. Publique as Edge Functions `consulta-cnpj`, `sync-onedrive` e `admin-users`
   apenas após configurar secrets, `APP_URL` e revisar CORS.
7. Execute `supabase/tests/001_schema_security_smoke.sql` em banco descartável ou homologação.

O frontend não cria automaticamente projetos, usuários ou credenciais.

## Configurar o OneDrive

A fonte atual é a planilha autorizada no OneDrive. No portal online, um ADMIN usa **Sincronizar agora**; o backend cria um link temporário protegido, dispara o executor remoto e acompanha o resultado. Não existe sincronização agendada.

Na sincronização, os preços seguem a rota comercial: PR→PR usa base + IPI + ICMS-ST; PR→SC, PR→SP e SP→SP usam somente base + IPI. A rota PR→SP é derivada da mesma base fiscal PR sem ST da planilha.

Em **Administração → Ativação de produtos**, o administrador pode selecionar até 500 itens por operação, inativá-los em lote e reativá-los pela visualização de inativos. A inativação manual não é desfeita por sincronizações posteriores.

O workflow requer os secrets `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no repositório. O token que dispara o workflow permanece somente nos secrets do Supabase.

Como contingência local, após aplicar `supabase/migrations/0004_service_executor.sql`, valide ou sincronize com:

```powershell
.\scripts\run-local-onedrive-sync.ps1 -ValidateOnly
.\scripts\run-local-onedrive-sync.ps1
```

O executor local obtém as credenciais pelo Supabase CLI, mantém as chaves somente em memória e envia apenas dados estruturados.

## Testar e compilar

```powershell
npm test
npm run build
```

## Publicação no GitHub Pages

Portal publicado em `https://debasistema-max.github.io/` pelo workflow manual
`.github/workflows/pages.yml`. O repositório público é exclusivo do DebaPortal,
o HTTPS está obrigatório e cada nova publicação continua dependendo de um
disparo manual do workflow.

O build usa apenas as variáveis públicas `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` e `VITE_CNPJ_FUNCTION_URL`. Credenciais administrativas,
tokens Microsoft, planilhas e arquivos gerados não são publicados.

O roteiro completo, incluindo Supabase e CORS, está em
`docs/PUBLICACAO_GITHUB.md`.
