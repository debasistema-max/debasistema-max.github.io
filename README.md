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

## Publicar no GitHub Pages

Destino aprovado para preparação: `https://debasistema-max.github.io/`.

O repositório público `debasistema-max/debasistema-max.github.io` já existe e está
sem publicação do DebaPortal. Confirme novamente o estado do GitHub Pages antes
do primeiro envio para não sobrescrever conteúdo criado posteriormente.

1. Reautentique a conta `debasistema-max` no GitHub CLI ou no conector autorizado.
2. Confirme que o repositório `debasistema-max.github.io` continua disponível para este projeto.
3. Copie o conteúdo desta pasta para a raiz do repositório, sem incluir
   `.env.local`, `node_modules` ou `dist`.
4. Configure no repositório as variáveis `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` e `VITE_CNPJ_FUNCTION_URL`.
5. Ative GitHub Pages com origem GitHub Actions e, se desejado, proteção do ambiente `github-pages`.
6. Somente após aprovação, envie para `main`. O workflow testa, compila e publica automaticamente.

Não há comando de publicação automática executado por este projeto local.

O roteiro completo, incluindo Supabase e CORS, está em
`docs/PUBLICACAO_GITHUB.md`.
