# Publicação do DebaPortal no GitHub Pages

Destino publicado: `https://debasistema-max.github.io/`.

Primeira publicação concluída em 6 de novembro de 2026. O repositório é público,
o Pages usa GitHub Actions e o HTTPS está obrigatório. Novos deploys continuam
manuais pelo workflow `pages.yml`.

## 1. Estado da publicação

1. Repositório: `debasistema-max/debasistema-max.github.io`.
2. URL pública: `https://debasistema-max.github.io/`.
3. Origem do Pages: GitHub Actions.
4. Para uma nova publicação, reautentique o GitHub CLI na conta correta:

   ```powershell
   gh auth login -h github.com
   gh auth status
   ```

5. Não utilize o repositório do CRM como destino do portal.

## 2. Repositório independente

O repositório reservado chama-se:

```text
debasistema-max.github.io
```

O conteúdo de `debaportal` fica na raiz desse repositório. Não envie
`.env.local`, `node_modules`, `dist`, planilhas ou dados comerciais.

O repositório é público por exigência da hospedagem gratuita utilizada. Não
inclua arquivos comerciais, planilhas, segredos ou artefatos gerados.

## 3. Configurar o Supabase no GitHub

Em **Settings → Secrets and variables → Actions → Variables**, crie somente as
variáveis públicas:

```text
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=CHAVE_ANON_PUBLICA
VITE_CNPJ_FUNCTION_URL=https://SEU-PROJETO.supabase.co/functions/v1/consulta-cnpj
```

Não configure `service_role`, token Microsoft ou client secret no GitHub Pages.

## 4. Publicar uma nova versão

1. Revise as alterações na branch `main`.
2. Execute os testes locais.
3. Abra **Actions → Publicar DebaPortal no GitHub Pages → Run workflow**.
4. Aguarde os jobs `test-build` e `deploy` concluírem com sucesso.

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
