# Publicação do DebaPortal no GitHub Pages

Destino preparado: `https://debasistema-max.github.io/`.

Nenhum repositório foi criado e nenhuma publicação foi executada durante o
desenvolvimento. Este roteiro deve ser seguido somente após autorização final.
Em 5 de novembro de 2026, a API do repositório e a URL pública responderam `404`.

## 1. Verificações antes da criação

1. Abra `https://github.com/debasistema-max/debasistema-max.github.io` e confirme
   que o repositório continua inexistente.
2. Confirme que `https://debasistema-max.github.io/` não hospeda outro site.
3. Reautentique o GitHub CLI na conta correta:

   ```powershell
   gh auth login -h github.com
   gh auth status
   ```

4. Não utilize o repositório do CRM como destino do portal.

## 2. Criar o repositório independente

Crie um repositório público vazio chamado exatamente:

```text
debasistema-max.github.io
```

O conteúdo de `debaportal` deve ficar na raiz desse novo repositório. Não envie
`.env.local`, `node_modules`, `dist`, planilhas ou dados comerciais.

## 3. Configurar o Supabase no GitHub

Em **Settings → Secrets and variables → Actions → Variables**, crie somente as
variáveis públicas:

```text
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=CHAVE_ANON_PUBLICA
VITE_CNPJ_FUNCTION_URL=https://SEU-PROJETO.supabase.co/functions/v1/consulta-cnpj
```

Não configure `service_role`, token Microsoft ou client secret no GitHub Pages.

## 4. Configurar Pages e aprovação

1. Em **Settings → Pages**, selecione **GitHub Actions** como origem.
2. Em **Settings → Environments → github-pages**, configure aprovação manual se
   a conta/plano permitir revisores obrigatórios.
3. Revise o workflow `.github/workflows/pages.yml`.
4. Autorize o primeiro envio para `main` somente depois dos testes de homologação.

O workflow executará `npm ci`, `npm test` e `npm run build` antes do deploy. O
frontend usa rotas por hash e caminhos relativos, compatíveis com a URL raiz.

## 5. Configurar as Edge Functions

No projeto Supabase exclusivo do DebaPortal, configure:

```text
ALLOWED_ORIGINS=https://debasistema-max.github.io
APP_URL=https://debasistema-max.github.io
ALLOW_LOCALHOST=false
```

Depois publique `consulta-cnpj`, `sync-onedrive` e `admin-users` conforme
`supabase/functions/README.md`. Credenciais Microsoft permanecem somente nos
secrets das Edge Functions.

## 6. Verificação posterior

Após a publicação autorizada:

1. Abra `https://debasistema-max.github.io/` e confirme HTTPS.
2. Teste login ADMIN e VENDEDOR em janela anônima.
3. Confirme que preços e documentos não aparecem sem autenticação.
4. Teste em celular e desktop.
5. Confirme ausência de dados reais, segredos e marcas externas nos arquivos
   públicos.
