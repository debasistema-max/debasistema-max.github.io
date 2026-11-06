# Arquitetura do DebaPortal

## Diagnóstico

O repositório de origem contém outro sistema estático com Supabase e uma integração com OneDrive. O DebaPortal foi criado em diretório próprio e não importa módulos, configurações, credenciais, tabelas ou dados desse sistema.

O provedor de arquivos confirmado é o OneDrive, acessado pela Microsoft Graph. A nova integração usa registro de aplicativo, segredos e pasta próprios.

## Fronteiras

```text
Navegador
  -> frontend estático no GitHub Pages
  -> Supabase Auth independente
  -> PostgreSQL com RLS e RPCs seguras
  -> Edge Functions de CNPJ, imagens e verificação do OneDrive
  -> Microsoft Graph / BrasilAPI / catálogo de fotos autorizado

Solicitação online do ADMIN
  -> Edge Function gera download temporário do arquivo autorizado
  -> GitHub Actions executa somente sob demanda
  -> validação completa sem alterar o arquivo
  -> RPC de importação com secrets protegidos
  -> referências de fotos sincronizadas por código
```

- O navegador recebe apenas a chave pública `anon`.
- Preços exigem usuário autenticado e perfil ativo.
- O servidor recalcula preços ao salvar ou converter documentos.
- O refresh token do OneDrive existe apenas nos secrets da função de verificação.
- O link temporário e as chaves do executor nunca chegam ao navegador ou a arquivos versionados.
- PDFs e planilhas são gerados no navegador e não são armazenados.
- Fotos são carregadas sob demanda por uma função autenticada. O banco guarda somente caminhos validados, nunca o arquivo ou a origem pública.
- A indisponibilidade do OneDrive mantém a última versão estruturada no banco.
- Nenhuma operação baixa estoque ou envia dados para ERP.

## Busca e armazenamento

A busca usa texto normalizado e índices de trigramas em código, descrição, aplicações e sinônimos. As consultas são paginadas e limitadas a 100 registros por chamada.

Produtos, aplicações, preços, estoque e referências de fotos ficam separados. Documentos gravam snapshots mínimos de código, descrição, aplicação, preço e estoque da origem para preservar o histórico sem copiar o catálogo inteiro.

O banco não armazena arquivos, imagens em base64 ou logs extensos. `storage_summary()` ajuda a acompanhar o consumo.

## Contingência

- Falha no Drive: mostra a data da última sincronização e continua lendo a última versão.
- Falha no Supabase: não confirma o salvamento. O frontend não simula sucesso.
- Modo de demonstração: usa somente dados fictícios e fica desativado por padrão.

## Publicação

O frontend usa navegação por hash e `base: './'`, portanto funciona tanto na raiz `USUARIO.github.io` quanto em `USUARIO.github.io/deba/`.

O workflow dentro de `.github/workflows/pages.yml` testa e compila antes do deploy. Só deve ser colocado no repositório de destino após aprovação da publicação.
