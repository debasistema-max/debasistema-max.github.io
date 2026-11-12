import './styles.css';
import { api } from './services/api.js';
import { config, hasSupabaseConfig } from './config.js';
import { formatCnpj, isValidCnpj, lookupCnpj } from './lib/cnpj.js';
import { allowedOrigins, choosePriceTable, resolveCommercialContext } from './lib/commercial-context.js';
import { normalizeFilterSelection, toggleFilterSelection } from './lib/catalog-filters.js';
import { state, navigate, persistSessionState, setToast } from './state.js';
import { STATES, commercialApplicationValues, commercialYearValues, escapeHtml, formatDateTime, integer, money, onlyDigits, stockLevel } from './lib/utils.js';

const root = document.querySelector('#app');
let pendingImport = null;
let needsPasswordSetup = false;
let photoZoom = 1;
const photoCache = new Map();
const COMMERCIAL_LINES = ['Leve', 'Pesada', 'Utilitário'];

const routes = {
  home: 'Início',
  order: 'Pedidos',
  quotation: 'Cotações',
  lists: 'Listas comerciais',
  item: 'Consulta de item',
  documents: 'Documentos',
  admin: 'Administração'
};

function icon(name) {
  const paths = {
    order: '<path d="M6 3h12l1 4H5l1-4Z"/><path d="M5 7v14h14V7M9 11h6M9 15h6"/>',
    quotation: '<path d="M6 2h9l3 3v17H6z"/><path d="M14 2v4h4M9 11h6M9 15h6"/>',
    lists: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    item: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    admin: '<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6v.08H10V20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H3.9v-4H4a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6v-.1h4v.1a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1h.1v4H20a1.7 1.7 0 0 0-.6 1Z"/>'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.item}</svg>`;
}

function stateOptions(selected) {
  return STATES.map((uf) => `<option value="${uf}" ${uf === selected ? 'selected' : ''}>${uf}</option>`).join('');
}

function toastMarkup() {
  if (!state.toast) return '';
  return `<div class="toast toast-${escapeHtml(state.toast.type)}" role="status"><span>${escapeHtml(state.toast.message)}</span><button type="button" data-action="dismiss-toast" aria-label="Fechar">×</button></div>`;
}

function photoDialogMarkup() {
  return `<dialog id="product-photo-dialog" class="photo-dialog" aria-labelledby="product-photo-title">
    <div class="photo-dialog-head">
      <div><span id="product-photo-code"></span><strong id="product-photo-title">Foto do produto</strong></div>
      <div class="photo-toolbar" aria-label="Controles de zoom">
        <button type="button" data-action="photo-zoom-out" aria-label="Diminuir zoom">−</button>
        <span id="product-photo-zoom">100%</span>
        <button type="button" data-action="photo-zoom-in" aria-label="Aumentar zoom">+</button>
        <button type="button" data-action="photo-zoom-reset">Ajustar</button>
        <button type="button" data-action="close-product-photo" aria-label="Fechar foto">×</button>
      </div>
    </div>
    <div class="photo-stage" data-photo-stage><img id="product-photo-full" alt=""></div>
    <p>Use os botões para ampliar. Toque duas vezes na foto para alternar o zoom.</p>
  </dialog>`;
}

function renderSetup() {
  root.innerHTML = `
    <main class="setup-shell">
      <section class="setup-card">
        <div class="brand-mark">D</div>
        <p class="eyebrow">Configuração necessária</p>
        <h1>DebaPortal</h1>
        <p>O frontend está pronto, mas ainda não recebeu as credenciais públicas do projeto Supabase exclusivo.</p>
        <ol>
          <li>Copie <code>.env.example</code> para <code>.env.local</code>.</li>
          <li>Informe a URL e a chave pública <code>anon</code>.</li>
          <li>Execute as migrações somente no novo projeto DebaPortal.</li>
        </ol>
        <p class="setup-note">Nenhuma credencial administrativa deve ser adicionada ao frontend.</p>
      </section>
    </main>`;
}

function renderLogin() {
  root.innerHTML = `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="login-title">
        <div class="brand-lockup"><div class="brand-mark">D</div><span>DebaPortal</span></div>
        <div class="login-copy">
          <p class="eyebrow">Acesso comercial</p>
          <h1 id="login-title">Entre para continuar</h1>
          <p>Consulte itens, prepare documentos e gere listas com poucos passos.</p>
        </div>
        ${config.demoEnabled ? '<div class="demo-banner">Modo de demonstração. Use qualquer e-mail e senha com 6 caracteres.</div>' : ''}
        <form id="login-form" class="stack-form">
          <label>E-mail<input name="email" type="email" autocomplete="username" required></label>
          <label>Senha<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
          <button class="button button-primary button-large" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Entrando...' : 'Entrar'}</button>
        </form>
        <p class="privacy-note">Acesso restrito. Preços e documentos comerciais exigem autenticação.</p>
      </section>
      <aside class="login-aside" aria-hidden="true"><div><span>Busca rápida</span><span>Estoque por filial</span><span>Documentos comerciais</span></div></aside>
      ${toastMarkup()}
    </main>`;
}

function renderPasswordSetup() {
  root.innerHTML = `
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="password-title">
        <div class="brand-lockup"><div class="brand-mark">D</div><span>DebaPortal</span></div>
        <div class="login-copy">
          <p class="eyebrow">Primeiro acesso</p>
          <h1 id="password-title">Defina sua senha</h1>
          <p>Crie uma senha com pelo menos 8 caracteres para concluir o acesso.</p>
        </div>
        <form id="set-password-form" class="stack-form">
          <label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
          <label>Confirmar senha<input name="confirmation" type="password" autocomplete="new-password" minlength="8" required></label>
          <button class="button button-primary button-large" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Salvando...' : 'Salvar senha e entrar'}</button>
        </form>
        <p class="privacy-note">A senha é processada diretamente pelo serviço de autenticação e não é armazenada no frontend.</p>
      </section>
      <aside class="login-aside" aria-hidden="true"><div><span>Acesso protegido</span><span>Dados comerciais restritos</span><span>Sessão segura</span></div></aside>
      ${toastMarkup()}
    </main>`;
}

function currentTableName() {
  return state.priceTables.find((table) => table.id === state.priceTableId)?.name || 'Selecione a tabela';
}

function renderShell() {
  const admin = state.profile?.role === 'ADMIN';
  const route = routes[state.route] ? state.route : 'home';
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <button class="brand-button" type="button" data-route="home" aria-label="Ir para o início"><span class="brand-mark brand-mark-small">D</span><strong>DebaPortal</strong></button>
        <div class="topbar-actions">
          <button class="icon-button mobile-only" type="button" data-action="toggle-nav" aria-label="Abrir menu">☰</button>
          <div class="user-summary"><strong>${escapeHtml(state.profile?.full_name || 'Usuário')}</strong><span>${admin ? 'Administrador' : 'Vendedor'}</span></div>
          <button class="button button-ghost" type="button" data-action="sign-out">Sair</button>
        </div>
      </header>
      <div class="workspace">
        <nav class="side-nav" aria-label="Navegação principal">
          ${navButton('home', 'item', 'Início', route)}
          ${navButton('order', 'order', 'Pedidos', route)}
          ${navButton('quotation', 'quotation', 'Cotações', route)}
          ${navButton('lists', 'lists', 'Listas comerciais', route)}
          ${navButton('item', 'item', 'Consulta de item', route)}
          ${navButton('documents', 'quotation', 'Documentos', route)}
          ${admin ? navButton('admin', 'admin', 'Administração', route) : ''}
        </nav>
        <main class="main-content">
          ${syncWarning()}
          ${route !== 'admin' ? contextBar() : ''}
          <div id="route-view">${renderRoute(route)}</div>
        </main>
      </div>
      ${toastMarkup()}
    </div>${photoDialogMarkup()}`;
  void hydrateProductPhotos(root);
}

function navButton(route, iconName, label, current) {
  return `<button type="button" data-route="${route}" class="nav-link ${current === route ? 'active' : ''}">${icon(iconName)}<span>${label}</span></button>`;
}

function syncWarning() {
  if (!state.lastSync) return '<div class="notice notice-warn">Catálogo ainda não sincronizado. Um administrador deve importar ou sincronizar os dados.</div>';
  const failed = state.lastSync.status && !['success', 'completed'].includes(String(state.lastSync.status).toLowerCase());
  const age = state.lastSync.finished_at ? Date.now() - new Date(state.lastSync.finished_at).getTime() : Infinity;
  if (!failed && age < 48 * 60 * 60 * 1000) return '';
  return `<div class="notice notice-warn">Usando a última versão disponível (${escapeHtml(formatDateTime(state.lastSync.finished_at || state.lastSync.started_at))}). Os dados podem estar desatualizados.</div>`;
}

function contextBar() {
  const filteredTables = state.priceTables.filter((table) => (!table.destination_state || table.destination_state === state.destinationState) && (!table.origin_code || table.origin_code === state.originCode));
  const origins = allowedOrigins(state.priceTables, state.destinationState);
  const originOptions = origins.length ? origins : [state.originCode].filter(Boolean);
  return `<section class="context-bar" aria-label="Contexto comercial">
    <label>Destino<select data-context="destinationState">${stateOptions(state.destinationState)}</select></label>
    <label>Filial de envio<select data-context="originCode" ${originOptions.length ? '' : 'disabled'}>${originOptions.map((origin) => `<option value="${escapeHtml(origin)}" ${state.originCode === origin ? 'selected' : ''}>${escapeHtml(origin)}</option>`).join('')}</select></label>
    <label class="context-table">Tabela<select data-context="priceTableId"><option value="">Selecione</option>${filteredTables.map((table) => `<option value="${table.id}" ${state.priceTableId === table.id ? 'selected' : ''}>${escapeHtml(table.name)} · v${escapeHtml(table.version)}</option>`).join('')}</select></label>
    <div class="context-sync"><span>Última atualização</span><strong>${escapeHtml(formatDateTime(state.lastSync?.finished_at || state.lastSync?.started_at))}</strong></div>
  </section>`;
}

function renderRoute(route) {
  if (route === 'home') return renderHome();
  if (route === 'item') return renderCatalog('item');
  if (route === 'lists') return renderLists();
  if (route === 'order') return renderDocumentBuilder('order');
  if (route === 'quotation') return renderDocumentBuilder('quotation');
  if (route === 'documents') return renderDocuments();
  if (route === 'admin') return renderAdmin();
  return renderHome();
}

function pageHeader(kicker, title, description, actions = '') {
  return `<header class="page-header"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
}

function renderHome() {
  const cards = [
    ['order', 'order', 'Pedidos', 'Monte um pedido, valide o estoque e salve o documento.'],
    ['quotation', 'quotation', 'Cotações', 'Prepare uma proposta e converta em pedido quando aprovada.'],
    ['lists', 'lists', 'Listas comerciais', 'Filtre itens e gere PDF ou Excel sem armazenar arquivos.'],
    ['item', 'item', 'Consulta de item', 'Pesquise por código, descrição, veículo, aplicação ou sinônimo.']
  ];
  return `${pageHeader('Visão rápida', 'O que você precisa fazer?', 'Escolha uma opção para começar.')}
    <section class="home-grid">${cards.map(([route, iconName, title, text]) => `<button class="home-card" type="button" data-route="${route}"><span class="home-icon">${icon(iconName)}</span><span><strong>${title}</strong><small>${text}</small></span><b aria-hidden="true">→</b></button>`).join('')}</section>
    <section class="status-strip"><div><span>Tabela atual</span><strong>${escapeHtml(currentTableName())}</strong></div><div><span>Destino / origem</span><strong>${state.destinationState} / ${state.originCode}</strong></div><div><span>Dados atualizados</span><strong>${escapeHtml(formatDateTime(state.lastSync?.finished_at || state.lastSync?.started_at))}</strong></div></section>`;
}

function multiFilter(label, filter, values) {
  const selected = normalizeFilterSelection(state.filters[filter]);
  const summary = selected.length === 0 ? 'Todas' : selected.length === 1 ? selected[0] : `${selected.length} selecionadas`;
  return `<details class="multi-filter" name="catalog-filters" ${state.openFilter === filter ? 'open' : ''}>
    <summary data-filter-summary="${filter}"><span>${label}</span><strong>${escapeHtml(summary)}</strong></summary>
    <div class="multi-filter-menu">
      <div class="multi-filter-menu-head"><span>${label}</span><button type="button" data-action="clear-multi-filter" data-filter-name="${filter}" ${selected.length ? '' : 'disabled'}>Limpar</button></div>
      <div class="multi-filter-options">${values.length ? values.map((value) => `<label><input type="checkbox" data-multi-filter="${filter}" value="${escapeHtml(value)}" ${selected.includes(value) ? 'checked' : ''}><span>${escapeHtml(value)}</span></label>`).join('') : '<p>Nenhuma opção disponível.</p>'}</div>
    </div>
  </details>`;
}

function applyCatalogOptions(options) {
  state.catalogOptions = options;
  state.filters.category = normalizeFilterSelection(state.filters.category).filter((value) => options.categories.includes(value));
  state.filters.line = normalizeFilterSelection(state.filters.line).filter((value) => options.lines.includes(value));
  state.filters.brand = normalizeFilterSelection(state.filters.brand).filter((value) => options.brands.includes(value));
}

function searchControls(extra = '') {
  return `<section class="search-panel">
    <label class="search-field"><span class="sr-only">Pesquisar produtos</span>${icon('item')}<input id="product-query" value="${escapeHtml(state.query)}" placeholder="Código, descrição, veículo, modelo, aplicação ou sinônimo"><button type="button" data-action="search-products">Buscar</button></label>
    <div class="filter-row">${multiFilter('Categorias', 'category', state.catalogOptions.categories)}${multiFilter('Linhas', 'line', state.catalogOptions.lines)}${multiFilter('Marcas', 'brand', state.catalogOptions.brands)}<label>Disponibilidade<select data-filter="inStockOnly"><option value="false" ${!state.filters.inStockOnly ? 'selected' : ''}>Todos os itens</option><option value="true" ${state.filters.inStockOnly ? 'selected' : ''}>Somente disponíveis</option></select></label>${extra}</div>
  </section>`;
}

function renderCatalog(mode, cartType = '') {
  const title = mode === 'item' ? 'Consulta de item' : 'Adicionar produtos';
  const description = mode === 'item' ? 'Encontre rapidamente preços, aplicações e estoque por filial.' : 'Pesquise e adicione produtos ao documento.';
  return `${mode === 'item' ? pageHeader('Catálogo', title, description) : ''}${searchControls()}${productResults(mode, cartType)}`;
}

function productResults(mode, cartType) {
  const totalPages = Math.max(1, Math.ceil(state.productTotal / state.pageSize));
  if (state.busy) return '<div class="loading-state">Carregando produtos...</div>';
  if (!state.products.length) return '<div class="empty-state"><strong>Nenhum item encontrado</strong><span>Ajuste a pesquisa ou os filtros.</span></div>';
  return `<section class="results-section"><div class="results-meta"><span>${integer(state.productTotal)} item(ns)</span><span>Página ${state.productPage} de ${totalPages}</span></div><div class="product-grid">
    ${state.products.map((product) => productCard(product, mode, cartType)).join('')}
  </div><div class="pagination"><button class="button button-secondary" data-page="${state.productPage - 1}" ${state.productPage <= 1 ? 'disabled' : ''}>Anterior</button><button class="button button-secondary" data-page="${state.productPage + 1}" ${state.productPage >= totalPages ? 'disabled' : ''}>Próxima</button></div></section>`;
}

function commercialListResults() {
  const totalPages = Math.max(1, Math.ceil(state.productTotal / state.pageSize));
  if (state.busy) return '<div class="loading-state">Carregando produtos...</div>';
  if (!state.products.length) return '<div class="empty-state"><strong>Nenhum item encontrado</strong><span>Ajuste a pesquisa ou os filtros.</span></div>';
  const custom = state.listMode === 'custom';
  const rows = state.products.map((product) => {
    const level = stockLevel(product.stock_origin);
    return `<tr>
      ${custom ? `<td class="list-check-cell" data-label="Selecionar"><input type="checkbox" data-list-product="${product.id}" ${state.listSelection.has(product.id) ? 'checked' : ''} aria-label="Incluir ${escapeHtml(product.code)}"></td>` : ''}
      <td data-label="Código"><span class="code-chip">${escapeHtml(product.code)}</span></td>
      <td data-label="Descrição" class="list-description"><strong>${escapeHtml(product.description)}</strong><small>${escapeHtml(product.category || 'Sem categoria')}</small></td>
      <td data-label="Aplicação" class="list-application">${escapeHtml(commercialApplicationValues(product.applications).join(' · ') || '—')}</td>
      <td data-label="Ano" class="list-year">${escapeHtml(commercialYearValues(product.years).join(' · ') || '—')}</td>
      <td data-label="Preço" class="list-price">${product.price === null ? 'Sem preço' : money(product.price)}</td>
      <td data-label="Estoque PR">${product.stock_pr === null ? '—' : integer(product.stock_pr)}</td>
      <td data-label="Estoque SP">${product.stock_sp === null ? '—' : integer(product.stock_sp)}</td>
      <td data-label="Disponibilidade"><span class="stock-badge stock-${level.key}"><i></i>${escapeHtml(level.label)}</span></td>
    </tr>`;
  }).join('');
  return `<section class="results-section commercial-list-results">
    <div class="results-meta"><span>${integer(state.productTotal)} item(ns)</span><span>Página ${state.productPage} de ${totalPages}</span></div>
    <div class="table-wrap"><table class="commercial-list-table"><thead><tr>${custom ? '<th class="list-check-cell">Incluir</th>' : ''}<th>Código</th><th>Descrição</th><th>Aplicação</th><th>Ano</th><th>Preço</th><th>PR</th><th>SP</th><th>Disponibilidade</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pagination"><button class="button button-secondary" data-page="${state.productPage - 1}" ${state.productPage <= 1 ? 'disabled' : ''}>Anterior</button><button class="button button-secondary" data-page="${state.productPage + 1}" ${state.productPage >= totalPages ? 'disabled' : ''}>Próxima</button></div>
  </section>`;
}

function productCard(product, mode, cartType) {
  const level = stockLevel(product.stock_origin);
  const price = product.price === null ? 'Sem preço' : money(product.price);
  return `<article class="product-card">
    <button class="product-photo" type="button" data-product-photo="${escapeHtml(product.code)}" data-photo-label="${escapeHtml(product.description)}" aria-label="Ampliar foto de ${escapeHtml(product.description)}" disabled>
      <span data-photo-placeholder>Carregando foto…</span>
    </button>
    <div class="product-top"><span class="code-chip">${escapeHtml(product.code)}</span><span class="stock-badge stock-${level.key}"><i></i>${escapeHtml(level.label)}</span></div>
    <h3>${escapeHtml(product.description)}</h3>
    <p>${escapeHtml(product.applications.join(' · ') || 'Aplicação não informada')}</p>
    <div class="product-tags"><span>${escapeHtml(product.category || 'Sem categoria')}</span><span>${escapeHtml(product.product_line || 'Sem linha')}</span>${product.brand ? `<span>${escapeHtml(product.brand)}</span>` : ''}</div>
    <div class="stock-grid"><div class="${state.originCode === 'PR' ? 'stock-selected' : ''}"><span>PR${state.originCode === 'PR' ? ' · envio' : ''}</span><strong>${integer(product.stock_pr)}</strong></div><div class="${state.originCode === 'SP' ? 'stock-selected' : ''}"><span>SP${state.originCode === 'SP' ? ' · envio' : ''}</span><strong>${integer(product.stock_sp)}</strong></div><div class="price ${product.price === null ? 'price-missing' : ''}"><span>Preço</span><strong>${price}</strong></div></div>
    ${mode === 'list' ? (state.listMode === 'custom' ? `<label class="list-product-select"><input type="checkbox" data-list-product="${product.id}" ${state.listSelection.has(product.id) ? 'checked' : ''}> Incluir na lista personalizada</label>` : '') : `<div class="product-actions">${mode === 'item' ? `<button class="button button-secondary" data-add-product="${product.id}" data-cart="quotation">+ Cotação</button><button class="button button-primary" data-add-product="${product.id}" data-cart="order">+ Pedido</button>` : `<button class="button button-primary button-full" data-add-product="${product.id}" data-cart="${cartType}">Adicionar</button>`}</div>`}
  </article>`;
}

function cachedProductPhoto(code) {
  if (!photoCache.has(code)) {
    const request = api.getProductImage(code)
      .then((blob) => {
        if (!blob) photoCache.delete(code);
        return blob ? URL.createObjectURL(blob) : null;
      })
      .catch(() => {
        photoCache.delete(code);
        return null;
      });
    photoCache.set(code, request);
  }
  return photoCache.get(code);
}

async function hydrateProductPhotos(scope) {
  if (!api || !state.session) return;
  const buttons = [...scope.querySelectorAll('[data-product-photo]')];
  for (let start = 0; start < buttons.length; start += 4) {
    await Promise.all(buttons.slice(start, start + 4).map(async (button) => {
      const url = await cachedProductPhoto(button.dataset.productPhoto);
      if (!button.isConnected) return;
      if (!url) {
        button.querySelector('[data-photo-placeholder]').textContent = 'Sem foto';
        button.classList.add('photo-missing');
        return;
      }
      const image = document.createElement('img');
      image.src = url;
      image.alt = button.dataset.photoLabel || button.dataset.productPhoto;
      image.loading = 'lazy';
      button.replaceChildren(image);
      button.dataset.photoUrl = url;
      button.disabled = false;
    }));
  }
}

function clearPhotoCache() {
  for (const pending of photoCache.values()) {
    Promise.resolve(pending).then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
  }
  photoCache.clear();
}

function applyPhotoZoom(nextZoom) {
  photoZoom = Math.min(4, Math.max(1, Number(nextZoom) || 1));
  const dialog = document.querySelector('#product-photo-dialog');
  dialog?.style.setProperty('--photo-zoom', String(photoZoom));
  const image = dialog?.querySelector('#product-photo-full');
  if (image) {
    image.style.width = `${photoZoom * 100}%`;
    image.style.minWidth = `${photoZoom * 100}%`;
  }
  const label = dialog?.querySelector('#product-photo-zoom');
  if (label) label.textContent = `${Math.round(photoZoom * 100)}%`;
}

function openProductPhoto(button) {
  const dialog = document.querySelector('#product-photo-dialog');
  const image = dialog?.querySelector('#product-photo-full');
  if (!dialog || !image || !button.dataset.photoUrl) return;
  dialog.querySelector('#product-photo-code').textContent = button.dataset.productPhoto;
  dialog.querySelector('#product-photo-title').textContent = button.dataset.photoLabel || 'Foto do produto';
  image.src = button.dataset.photoUrl;
  image.alt = button.dataset.photoLabel || button.dataset.productPhoto;
  applyPhotoZoom(1);
  dialog.showModal();
}

function renderDocumentBuilder(type) {
  const isOrder = type === 'order';
  const draft = state.documentDrafts[type];
  const cart = state.carts[type];
  const missingPrice = cart.some((item) => item.product.price === null);
  const total = cart.reduce((sum, item) => sum + Number(item.quantity) * Number(item.product.price || 0), 0);
  return `${pageHeader(isOrder ? 'Operação comercial' : 'Proposta comercial', isOrder ? 'Novo pedido' : 'Nova cotação', isOrder ? 'Confirme cliente, produtos, preço e disponibilidade antes de salvar.' : 'Monte a cotação e converta em pedido após nova validação.', `<button class="button button-secondary" data-route="documents">Ver documentos</button>`)}
    <div class="builder-grid"><section class="panel customer-panel"><div class="section-title"><span>1</span><div><h2>Cliente e condições</h2><p>O CNPJ é consultado, mas não cria cadastro permanente.</p></div></div>
      <div class="form-grid"><label>CNPJ<div class="input-action"><input data-draft="${type}" data-field="cnpj" value="${escapeHtml(formatCnpj(draft.cnpj))}" inputmode="numeric" placeholder="00.000.000/0000-00"><button class="button button-secondary" type="button" data-action="lookup-cnpj" data-type="${type}">Consultar</button></div></label><label>Razão social<input data-draft="${type}" data-field="legalName" value="${escapeHtml(draft.legalName)}"></label><label>Nome fantasia<input data-draft="${type}" data-field="tradeName" value="${escapeHtml(draft.tradeName)}"></label><label>UF do cliente<select data-draft="${type}" data-field="clientState"><option value="">Selecione</option>${stateOptions(draft.clientState)}</select></label><label class="full-field">Observações<textarea data-draft="${type}" data-field="notes" rows="2">${escapeHtml(draft.notes)}</textarea></label></div>
    </section>
    <section class="panel products-panel"><div class="section-title"><span>2</span><div><h2>Produtos</h2><p>Preço pela tabela ${escapeHtml(currentTableName())}.</p></div></div>${renderCatalog('builder', type)}</section>
    <aside class="panel cart-panel"><div class="section-title"><span>3</span><div><h2>Resumo</h2><p>${cart.length} item(ns)${draft.id ? ' · rascunho salvo' : ''}</p></div></div>${cartMarkup(type, cart)}${missingPrice ? '<div class="notice notice-error">Há item sem preço na tabela selecionada.</div>' : ''}<div class="cart-total"><span>Total</span><strong>${missingPrice ? '—' : money(total)}</strong></div><div class="cart-actions"><button class="button button-primary button-full" type="button" data-action="save-document" data-type="${type}" ${missingPrice ? 'disabled' : ''}>${draft.id ? 'Atualizar rascunho' : (isOrder ? 'Salvar pedido' : 'Salvar cotação')}</button><div><button class="button button-secondary" data-action="export-current" data-format="pdf" data-type="${type}" ${!cart.length || missingPrice ? 'disabled' : ''}>PDF</button><button class="button button-secondary" data-action="export-current" data-format="xlsx" data-type="${type}" ${!cart.length || missingPrice ? 'disabled' : ''}>Excel</button></div><button class="button button-ghost button-full" data-action="reset-document" data-type="${type}">Novo documento</button></div></aside></div>`;
}

function cartMarkup(type, cart) {
  if (!cart.length) return '<div class="empty-cart">Adicione o primeiro item pela busca.</div>';
  return `<div class="cart-list">${cart.map((item) => `<div class="cart-item"><div><strong>${escapeHtml(item.product.code)}</strong><span>${escapeHtml(item.product.description)}</span><small>${item.product.price === null ? 'Sem preço' : `${money(item.product.price)} por unidade`} · ${escapeHtml(state.originCode)}: ${integer(item.product.stock_origin)}</small></div><label>Qtd.<input type="number" min="1" step="1" value="${item.quantity}" data-cart-quantity="${item.product.id}" data-cart="${type}"></label><button class="remove-button" type="button" data-remove-product="${item.product.id}" data-cart="${type}" aria-label="Remover">×</button></div>`).join('')}</div>`;
}

function renderLists() {
  const custom = state.listMode === 'custom';
  const categoryPending = state.listMode === 'category' && state.filters.category.length === 0;
  const exportDisabled = state.busy || (custom ? state.listSelection.size === 0 : state.productTotal === 0 || categoryPending);
  const actions = `<button class="button button-secondary" data-action="export-list" data-format="pdf" ${exportDisabled ? 'disabled' : ''}>Exportar PDF</button><button class="button button-primary" data-action="export-list" data-format="xlsx" ${exportDisabled ? 'disabled' : ''}>Exportar Excel</button>`;
  const selection = custom ? `<section class="list-selection-bar"><span><strong>${integer(state.listSelection.size)}</strong> produto(s) selecionado(s)</span><div><button class="button button-secondary button-small" data-action="select-visible-products">Selecionar esta página</button><button class="button button-ghost button-small" data-action="clear-list-selection" ${state.listSelection.size ? '' : 'disabled'}>Limpar seleção</button></div></section>` : '';
  const guidance = categoryPending ? '<div class="notice notice-warn">Escolha uma categoria para gerar a lista.</div>' : '';
  return `${pageHeader('Exportação', 'Listas comerciais', 'Filtre a lista e gere o arquivo no navegador. O arquivo não é armazenado no Supabase.', actions)}
    <section class="commercial-list-hero"><div><span class="eyebrow">Catálogo comercial</span><h2>Aplicações e anos organizados</h2><p>Visual limpo para consulta e compartilhamento, com preço e disponibilidade por filial.</p></div><div class="commercial-line-badges"><span>Linhas</span>${COMMERCIAL_LINES.map((line) => `<strong>${line}</strong>`).join('')}</div></section>
    <div class="shortcut-row"><button class="${state.listMode === 'all' ? 'active' : ''}" data-list-shortcut="all">Lista completa</button><button class="${state.listMode === 'stock' ? 'active' : ''}" data-list-shortcut="stock">Somente disponíveis</button><button class="${state.listMode === 'category' ? 'active' : ''}" data-list-shortcut="category">Por categoria</button><button class="${custom ? 'active' : ''}" data-list-shortcut="custom">Personalizada</button></div>${guidance}${searchControls()}${selection}${commercialListResults()}`;
}

function renderDocuments() {
  return `${pageHeader('Histórico', 'Pedidos e cotações', 'Vendedores consultam seus documentos. Administradores consultam todos.')}
      <section class="panel document-list">${state.documents.length ? `<div class="table-wrap"><table><thead><tr><th>Número</th><th>Tipo</th><th>Cliente</th><th>Status</th><th>Total</th><th>Data</th><th>Ações</th></tr></thead><tbody>${state.documents.map((doc) => `<tr><td data-label="Número"><strong>${escapeHtml(doc.document_number || 'Rascunho')}</strong></td><td data-label="Tipo">${doc.document_type === 'order' ? 'Pedido' : 'Cotação'}</td><td data-label="Cliente">${escapeHtml(doc.customer_legal_name || '-')}</td><td data-label="Status"><span class="status-chip">${escapeHtml(doc.status || 'RASCUNHO')}</span></td><td data-label="Total">${money(doc.total_amount)}</td><td data-label="Data">${escapeHtml(formatDateTime(doc.created_at))}</td><td data-label="Ações">${documentActions(doc)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><strong>Nenhum documento salvo</strong><span>Pedidos e cotações aparecerão aqui.</span></div>'}</section>`;
}

function documentActions(doc) {
  const status = String(doc.status || 'RASCUNHO').toUpperCase();
  const actions = [];
  if (status === 'RASCUNHO') actions.push(`<button class="button button-secondary button-small" data-document-id="${doc.id}" data-status="GERADO">Gerar</button>`);
  if (status === 'GERADO') actions.push(`<button class="button button-secondary button-small" data-document-id="${doc.id}" data-status="ENVIADO">Marcar enviado</button>`);
  if (!['CANCELADO'].includes(status)) actions.push(`<button class="button button-secondary button-small" data-document-id="${doc.id}" data-status="CANCELADO">Cancelar</button>`);
  if (doc.document_type === 'quotation' && status !== 'CANCELADO') actions.push(`<button class="button button-primary button-small" data-convert="${doc.id}">Converter</button>`);
  actions.push(`<button class="button button-secondary button-small" data-export-document="${doc.id}" data-format="pdf">PDF</button>`);
  actions.push(`<button class="button button-secondary button-small" data-export-document="${doc.id}" data-format="xlsx">Excel</button>`);
  return `<div class="table-actions">${actions.join('')}</div>`;
}

function usersAdminPanel(summary) {
  const inviteForm = `<form id="invite-user-form" class="compact-form invite-user-form">
    <input name="fullName" maxlength="160" placeholder="Nome do usuário" required>
    <input name="email" type="email" maxlength="254" placeholder="E-mail" required>
    <button class="button button-primary" type="submit">Enviar convite</button>
  </form>`;
  const rows = summary.profiles.map((profile) => {
    const branchIds = Array.isArray(profile.branch_ids) ? profile.branch_ids : [];
    const priceTableIds = Array.isArray(profile.price_table_ids) ? profile.price_table_ids : [];
    const accessEditor = profile.role === 'ADMIN'
      ? '<span class="muted">Acesso administrativo total</span>'
      : `<details class="access-details"><summary>Configurar acessos</summary><form class="access-form" data-profile-access="${escapeHtml(profile.id)}">
          <label>Filiais<select name="branchIds" multiple size="${Math.min(4, Math.max(2, summary.branches.length))}">${summary.branches.map((branch) => `<option value="${escapeHtml(branch.id)}" ${branchIds.includes(branch.id) ? 'selected' : ''}>${escapeHtml(branch.code)} · ${escapeHtml(branch.name)}</option>`).join('')}</select></label>
          <label>Tabelas<select name="priceTableIds" multiple size="${Math.min(4, Math.max(2, state.priceTables.length))}">${state.priceTables.map((table) => `<option value="${escapeHtml(table.id)}" ${priceTableIds.includes(table.id) ? 'selected' : ''}>${escapeHtml(table.code)} · v${escapeHtml(table.version)}</option>`).join('')}</select></label>
          <button class="button button-primary button-small" type="submit">Salvar acessos</button>
        </form></details>`;
    const actions = profile.id === state.profile.id
      ? '<span class="muted">Sessão atual</span>'
      : `<div class="table-actions"><button class="button button-secondary button-small" data-profile-id="${escapeHtml(profile.id)}" data-role="${profile.role === 'ADMIN' ? 'VENDEDOR' : 'ADMIN'}" data-active="${profile.active}">${profile.role === 'ADMIN' ? 'Tornar vendedor' : 'Tornar admin'}</button><button class="button button-secondary button-small" data-profile-id="${escapeHtml(profile.id)}" data-role="${escapeHtml(profile.role)}" data-active="${!profile.active}">${profile.active ? 'Desativar' : 'Ativar'}</button></div>`;
    return `<tr><td data-label="Usuário"><strong>${escapeHtml(profile.full_name || 'Sem nome')}</strong><small>${escapeHtml(profile.email || profile.id)}</small></td><td data-label="Perfil">${escapeHtml(profile.role)}</td><td data-label="Situação">${profile.active ? 'Ativo' : 'Inativo'}</td><td data-label="Acessos">${accessEditor}</td><td data-label="Ações">${actions}</td></tr>`;
  }).join('');
  const table = summary.profiles.length
    ? `<div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Situação</th><th>Acessos</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="muted">Nenhum perfil carregado.</p>';
  return `<section class="panel admin-card admin-wide"><div class="section-title"><span>9</span><div><h2>Usuários e permissões</h2><p>Convide usuários, aprove contas e limite filiais e tabelas para vendedores.</p></div></div>${inviteForm}${table}</section>`;
}

function syncChangeValue(value) {
  if (value === null || value === undefined || value === '') return '<span class="sync-empty-value">Sem valor</span>';
  const text = String(value);
  if (text.length <= 90) return `<span>${escapeHtml(text)}</span>`;
  return `<details class="sync-long-value"><summary>${escapeHtml(`${text.slice(0, 86)}…`)}</summary><p>${escapeHtml(text)}</p></details>`;
}

function syncHistoryPanel() {
  const audit = state.adminSync;
  const selected = audit.runs.find((run) => run.run_key === audit.selectedRunKey);
  const totalPages = Math.max(1, Math.ceil(audit.total / audit.pageSize));
  const scopeLabels = { PRODUTO: 'Produto', APLICACAO: 'Aplicação', PRECO: 'Preço', ESTOQUE: 'Estoque' };
  const runButtons = audit.runs.length
    ? audit.runs.map((run) => `<button type="button" class="sync-run-button ${run.run_key === audit.selectedRunKey ? 'active' : ''}" data-sync-run="${escapeHtml(run.run_key)}"><span><strong>${run.source_kind === 'ONEDRIVE' ? 'Sincronização online' : 'Importação manual'}</strong><small>${escapeHtml(formatDateTime(run.finished_at || run.started_at))}</small></span><span><b>${integer(run.changed_products)}</b><small>item(ns)</small></span></button>`).join('')
    : '<div class="empty-state"><strong>Nenhum histórico disponível</strong><span>As alterações aparecerão após a próxima sincronização.</span></div>';
  const rows = audit.changes.map((change) => `<tr>
    <td data-label="Item"><strong>${escapeHtml(change.product_code)}</strong></td>
    <td data-label="Área"><span class="sync-scope sync-scope-${escapeHtml(change.change_scope.toLowerCase())}">${escapeHtml(scopeLabels[change.change_scope] || change.change_scope)}</span></td>
    <td data-label="Campo"><strong>${escapeHtml(change.field_name)}</strong>${change.context_label ? `<small>${escapeHtml(change.context_label)}</small>` : ''}</td>
    <td data-label="Antes">${syncChangeValue(change.previous_value)}</td>
    <td data-label="Depois">${syncChangeValue(change.new_value)}</td>
  </tr>`).join('');
  const changes = !selected
    ? '<div class="empty-state"><strong>Selecione uma sincronização</strong><span>Escolha uma execução para consultar os itens alterados.</span></div>'
    : audit.total === 0
      ? '<div class="empty-state"><strong>Nenhuma alteração registrada</strong><span>O histórico detalhado começa nesta versão; execuções anteriores ou dados idênticos podem aparecer sem alterações.</span></div>'
      : `<div class="sync-change-heading"><div><strong>${integer(selected.changed_products)} item(ns) alterado(s)</strong><span>${integer(selected.changed_fields)} alteração(ões) registrada(s)</span></div><span>${escapeHtml((selected.import_kinds || []).join(' · '))}</span></div><div class="table-wrap"><table class="sync-change-table"><thead><tr><th>Item</th><th>Área</th><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>${rows}</tbody></table></div><div class="pagination"><button class="button button-secondary" data-sync-change-page="${audit.page - 1}" ${audit.page <= 1 ? 'disabled' : ''}>Anterior</button><span>Página ${audit.page} de ${totalPages}</span><button class="button button-secondary" data-sync-change-page="${audit.page + 1}" ${audit.page >= totalPages ? 'disabled' : ''}>Próxima</button></div>`;
  return `<section class="panel admin-card admin-wide sync-history-panel"><div class="section-title"><span>3</span><div><h2>Alterações por sincronização</h2><p>Consulte cada item modificado e compare os valores anterior e novo.</p></div></div><div class="sync-history-layout"><aside class="sync-run-list">${runButtons}</aside><div class="sync-change-content">${changes}</div></div></section>`;
}

function productsAdminPanel() {
  const catalog = state.adminCatalog;
  const inactive = catalog.status === 'INATIVOS';
  const totalPages = Math.max(1, Math.ceil(catalog.total / catalog.pageSize));
  const selectedCount = catalog.selection.size;
  const rows = catalog.items.map((product) => `<tr>
    <td class="selection-cell" data-label="Selecionar"><input type="checkbox" data-admin-product="${escapeHtml(product.id)}" aria-label="Selecionar ${escapeHtml(product.code)}" ${catalog.selection.has(product.id) ? 'checked' : ''}></td>
    <td data-label="Código"><strong>${escapeHtml(product.code)}</strong></td>
    <td data-label="Descrição">${escapeHtml(product.description)}</td>
    <td data-label="Categoria">${escapeHtml(product.category || '—')}</td>
    <td data-label="Linha">${escapeHtml(product.product_line || '—')}</td>
    <td data-label="Marca">${escapeHtml(product.brand || '—')}</td>
    <td data-label="Situação"><span class="status-chip ${inactive ? 'status-chip-inactive' : ''}">${inactive ? 'Inativo' : 'Ativo'}</span></td>
  </tr>`).join('');
  const table = catalog.items.length
    ? `<div class="table-wrap"><table class="admin-products-table"><thead><tr><th></th><th>Código</th><th>Descrição</th><th>Categoria</th><th>Linha</th><th>Marca</th><th>Situação</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty-state"><strong>Nenhum produto ${inactive ? 'inativo' : 'ativo'} encontrado</strong><span>Ajuste a pesquisa ou altere a visualização.</span></div>`;
  return `<section class="panel admin-card admin-wide"><div class="section-title"><span>8</span><div><h2>Ativação de produtos</h2><p>Selecione vários itens para ocultá-los do portal ou reativá-los. A escolha é preservada nas próximas sincronizações.</p></div></div>
    <form id="admin-product-search-form" class="admin-product-search"><input name="query" value="${escapeHtml(catalog.query)}" placeholder="Pesquisar por código ou descrição"><select name="status"><option value="ATIVOS" ${inactive ? '' : 'selected'}>Itens ativos</option><option value="INATIVOS" ${inactive ? 'selected' : ''}>Itens inativos</option></select><button class="button button-secondary" type="submit">Pesquisar</button></form>
    <div class="bulk-action-bar"><span><strong>${integer(selectedCount)}</strong> selecionado(s) de ${integer(catalog.total)} · máximo 500</span><div><button class="button button-secondary button-small" type="button" data-action="select-admin-page" ${catalog.items.length ? '' : 'disabled'}>Selecionar esta página</button><button class="button button-ghost button-small" type="button" data-action="clear-admin-selection" ${selectedCount ? '' : 'disabled'}>Limpar</button><button class="button ${inactive ? 'button-primary' : 'button-danger'} button-small" type="button" data-action="toggle-admin-products" ${selectedCount ? '' : 'disabled'}>${inactive ? 'Reativar selecionados' : 'Inativar selecionados'}</button></div></div>
    ${table}
    <div class="pagination"><button class="button button-secondary" data-admin-product-page="${catalog.page - 1}" ${catalog.page <= 1 ? 'disabled' : ''}>Anterior</button><span>Página ${catalog.page} de ${totalPages}</span><button class="button button-secondary" data-admin-product-page="${catalog.page + 1}" ${catalog.page >= totalPages ? 'disabled' : ''}>Próxima</button></div>
  </section>`;
}

function renderAdmin() {
  if (state.profile?.role !== 'ADMIN') return '<div class="notice notice-error">Acesso permitido somente para administradores.</div>';
  const summary = state.adminSummary || { profiles: [], storage: [], branches: [] };
  const databaseBytes = Number(summary.storage.find((row) => row.relation === 'Banco de dados')?.bytes || 0);
  const storageAlert = databaseBytes >= 400 * 1024 * 1024
    ? '<div class="notice notice-error">O banco atingiu o limite de alerta de 400 MB. Revise versões, índices e retenção antes de novas importações.</div>'
    : '';
  const syncJob = summary.syncJob;
  const syncLabels = { SOLICITADO: 'Solicitada', EM_EXECUCAO: 'Em execução', CONCLUIDO: 'Concluída', FALHOU: 'Falhou' };
  const syncActive = ['SOLICITADO', 'EM_EXECUCAO'].includes(syncJob?.status);
  const selectedTable = state.priceTables.find((table) => table.id === state.priceTableId);
  const syncStatus = syncJob
    ? `<div class="notice ${syncJob.status === 'FALHOU' ? 'notice-error' : ''}"><strong>${escapeHtml(syncLabels[syncJob.status] || syncJob.status)}</strong>${syncJob.summary?.produtos !== undefined ? `<span>${integer(syncJob.summary.produtos)} produto(s)</span>` : ''}${syncJob.summary?.precos !== undefined ? `<span>${integer(syncJob.summary.precos)} preço(s)</span>` : ''}${syncJob.summary?.estoque !== undefined ? `<span>${integer(syncJob.summary.estoque)} registro(s) de estoque</span>` : ''}${syncJob.summary?.fotos !== undefined && syncJob.summary?.fotos !== null ? `<span>${integer(syncJob.summary.fotos)} foto(s) catalogada(s), com busca alternativa para os demais itens</span>` : ''}${syncJob.summary?.aviso_fotos ? `<span>${escapeHtml(syncJob.summary.aviso_fotos)}</span>` : ''}${syncJob.error_message ? `<span>${escapeHtml(syncJob.error_message)}</span>` : ''}</div>`
    : '<p class="muted">Nenhuma solicitação online registrada.</p>';
  return `${pageHeader('Configuração', 'Administração', 'Gerencie a atualização dos dados sem expor credenciais no navegador.')}
    <div class="admin-grid">
      <section class="panel admin-card"><div class="section-title"><span>1</span><div><h2>Importação manual</h2><p>XLSX, XLS ou CSV. O arquivo original não é enviado nem armazenado.</p></div></div><input id="import-file" type="file" accept=".xlsx,.xls,.csv"><div id="import-preview">${pendingImport ? `<div class="import-ready"><strong>${escapeHtml(pendingImport.fileName)}</strong><span>${integer(pendingImport.rows.length)} linhas · tipo ${escapeHtml(pendingImport.kind)}</span><button class="button button-primary" data-action="commit-import">Validar e importar</button></div>` : '<p class="muted">Selecione um arquivo para validar os cabeçalhos.</p>'}</div></section>
      <section class="panel admin-card"><div class="section-title"><span>2</span><div><h2>Catálogo online</h2><p>Planilha e fotos são sincronizadas somente quando um administrador solicitar.</p></div></div><p>Última atualização: <strong>${escapeHtml(formatDateTime(state.lastSync?.finished_at || state.lastSync?.started_at))}</strong></p>${syncStatus}<div class="admin-sync-actions"><button class="button button-primary" data-action="sync-drive" ${syncActive ? 'disabled' : ''}>${syncActive ? 'Sincronizando…' : 'Sincronizar tudo'}</button><button class="button button-secondary" data-action="sync-photos" ${syncActive ? 'disabled' : ''}>Atualizar fotos pelo site</button></div></section>
      ${syncHistoryPanel()}
      <section class="panel admin-card sap-validation-card"><div class="section-title"><span>4</span><div><h2>Conferência manual SAP</h2><p>Sorteia 5 produtos de cada linha e prepara a comparação de preços e estoques.</p></div></div><div class="sap-validation-context"><span>Destino <strong>${escapeHtml(state.destinationState || '—')}</strong></span><span>Origem <strong>${escapeHtml(state.originCode || '—')}</strong></span><span>Tabela <strong>${escapeHtml(selectedTable?.code || 'Não selecionada')}</strong></span></div><p class="muted">Na planilha, preencha somente as colunas amarelas com os valores consultados no SAP.</p><button class="button button-primary" data-action="export-sap-validation" ${state.busy || !state.priceTableId ? 'disabled' : ''}>${state.busy ? 'Preparando…' : 'Gerar amostra de conferência'}</button></section>
      <section class="panel admin-card"><div class="section-title"><span>5</span><div><h2>Armazenamento</h2><p>Monitoramento das tabelas estruturadas do DebaPortal.</p></div></div>${storageAlert}${summary.storage.length ? `<ul class="metric-list">${summary.storage.map((row) => `<li><span>${escapeHtml(row.relation || row.table_name)}</span><strong>${escapeHtml(row.pretty_size || `${row.bytes || 0} bytes`)}</strong></li>`).join('')}</ul>` : '<p class="muted">Resumo indisponível.</p>'}</section>
      <section class="panel admin-card"><div class="section-title"><span>6</span><div><h2>Filiais</h2><p>Cadastre origens antes das tabelas comerciais.</p></div></div><form id="branch-form" class="compact-form"><input name="code" maxlength="20" placeholder="Código (ex.: SP)" required><input name="name" maxlength="120" placeholder="Nome da filial" required><select name="state" required><option value="">UF</option>${stateOptions('')}</select><button class="button button-primary" type="submit">Adicionar filial</button></form><ul class="inline-list">${summary.branches.map((branch) => `<li><strong>${escapeHtml(branch.code)}</strong><span>${escapeHtml(branch.name)} · ${escapeHtml(branch.state)}</span></li>`).join('')}</ul></section>
      <section class="panel admin-card"><div class="section-title"><span>7</span><div><h2>Tabelas comerciais</h2><p>Destino e origem definem onde cada tabela pode ser usada.</p></div></div><form id="price-table-form" class="compact-form"><input name="code" maxlength="60" placeholder="Código" required><input name="name" maxlength="160" placeholder="Nome" required><input name="version" type="number" min="1" value="1" required><select name="destinationState"><option value="">Todos os destinos</option>${stateOptions('')}</select><select name="originBranchId"><option value="">Todas as origens</option>${summary.branches.map((branch) => `<option value="${branch.id}">${escapeHtml(branch.code)} · ${escapeHtml(branch.name)}</option>`).join('')}</select><input name="validFrom" type="date" value="${new Date().toISOString().slice(0, 10)}" required><button class="button button-primary" type="submit">Criar tabela</button></form><ul class="inline-list">${state.priceTables.map((table) => `<li><strong>${escapeHtml(table.code)} · v${table.version}</strong><span>${escapeHtml(table.name)} · ${escapeHtml(table.destination_state || 'Todos')}</span></li>`).join('')}</ul></section>
      ${productsAdminPanel()}
      ${usersAdminPanel(summary)}
    </div>`;
}

function updateView() { renderShell(); }

async function loadAuthenticatedContext() {
  const [profile, context, catalogOptions] = await Promise.all([api.getProfile(), api.loadContext(), api.getCatalogFilterOptions()]);
  state.profile = profile;
  state.priceTables = context.priceTables;
  applyCatalogOptions(catalogOptions);
  state.lastSync = context.lastSync;
  const resolved = resolveCommercialContext(state.priceTables, state);
  state.originCode = resolved.originCode;
  state.priceTableId = resolved.priceTableId;
  if (!state.priceTableId && state.priceTables[0]) {
    const fallback = state.priceTables[0];
    if (fallback.destination_state) state.destinationState = fallback.destination_state;
    if (fallback.origin_code) state.originCode = fallback.origin_code;
    state.priceTableId = choosePriceTable(state.priceTables, state.destinationState, state.originCode)?.id || '';
  }
  persistSessionState();
  await Promise.all([refreshProducts(false), loadDocuments(false)]);
}

async function refreshProducts(shouldRender = true) {
  if (!api || !state.session) return;
  state.busy = true;
  if (shouldRender) updateView();
  try {
    const result = await api.searchProducts({ query: state.query, destinationState: state.destinationState, originCode: state.originCode,
      priceTableId: state.priceTableId, category: state.filters.category, line: state.filters.line, brand: state.filters.brand,
      inStockOnly: state.filters.inStockOnly, page: state.productPage, pageSize: state.pageSize });
    state.products = result.items;
    state.productTotal = result.total;
  } catch (error) {
    setToast(error.message || 'Falha ao consultar produtos.', 'error');
    state.products = [];
    state.productTotal = 0;
  } finally {
    state.busy = false;
    if (shouldRender) updateView();
  }
}

async function revalidateCarts(shouldRender = true) {
  const cartItems = [...state.carts.order, ...state.carts.quotation];
  if (!cartItems.length) {
    if (shouldRender) updateView();
    return;
  }
  const productsByCode = new Map();
  const codes = [...new Set(cartItems.map((item) => item.product.code).filter(Boolean))];
  try {
    for (let start = 0; start < codes.length; start += 5) {
      const batch = codes.slice(start, start + 5);
      const results = await Promise.all(batch.map((code) => api.searchProducts({
        query: code,
        destinationState: state.destinationState,
        originCode: state.originCode,
        priceTableId: state.priceTableId,
        category: '',
        line: '',
        brand: '',
        inStockOnly: false,
        page: 1,
        pageSize: 100
      })));
      results.forEach((result, index) => {
        const code = batch[index];
        const exact = result.items.find((product) => String(product.code).toUpperCase() === String(code).toUpperCase());
        if (exact) productsByCode.set(code, exact);
      });
    }
    for (const type of ['order', 'quotation']) {
      state.carts[type] = state.carts[type].map((item) => ({
        ...item,
        product: productsByCode.get(item.product.code) || { ...item.product, price: null, stock_origin: null }
      }));
    }
  } catch (error) {
    setToast(error.message || 'Falha ao atualizar preços e estoques do carrinho.', 'error');
  }
  if (shouldRender) updateView();
}

async function loadDocuments(shouldRender = true) {
  try { state.documents = await api.listDocuments(); }
  catch (error) { setToast(error.message || 'Falha ao carregar documentos.', 'error'); }
  if (shouldRender) updateView();
}

async function loadAdmin() {
  if (state.profile?.role !== 'ADMIN') return;
  state.busy = true; updateView();
  try {
    const [profiles, storage, branches, syncJob, catalog, syncRuns] = await Promise.all([
      api.listProfiles(), api.storageSummary(), api.listBranches(), api.getSyncJob(),
      api.listAdminProducts(state.adminCatalog), api.listSyncRuns(12)
    ]);
    state.adminCatalog.items = catalog.items;
    state.adminCatalog.total = catalog.total;
    state.adminSync.runs = syncRuns;
    if (!syncRuns.some((run) => run.run_key === state.adminSync.selectedRunKey)) {
      state.adminSync.selectedRunKey = syncRuns[0]?.run_key || '';
      state.adminSync.page = 1;
    }
    const syncChanges = await api.listSyncChanges(state.adminSync.selectedRunKey, state.adminSync.page, state.adminSync.pageSize);
    state.adminSync.changes = syncChanges.items;
    state.adminSync.total = syncChanges.total;
    state.adminSummary = { profiles, branches, syncJob, storage: Array.isArray(storage) ? storage : [storage].filter(Boolean) };
  } catch (error) { setToast(error.message || 'Falha ao carregar administração.', 'error'); }
  finally { state.busy = false; updateView(); }
}

async function loadSyncChanges(shouldRender = true) {
  try {
    const result = await api.listSyncChanges(state.adminSync.selectedRunKey, state.adminSync.page, state.adminSync.pageSize);
    state.adminSync.changes = result.items;
    state.adminSync.total = result.total;
  } catch (error) {
    setToast(error.message || 'Falha ao carregar alterações da sincronização.', 'error');
  }
  if (shouldRender) updateView();
}

async function loadSyncHistory(shouldRender = true) {
  try {
    const runs = await api.listSyncRuns(12);
    state.adminSync.runs = runs;
    if (!runs.some((run) => run.run_key === state.adminSync.selectedRunKey)) {
      state.adminSync.selectedRunKey = runs[0]?.run_key || '';
      state.adminSync.page = 1;
    }
    await loadSyncChanges(false);
  } catch (error) {
    setToast(error.message || 'Falha ao carregar histórico de sincronizações.', 'error');
  }
  if (shouldRender) updateView();
}

async function loadAdminProducts(shouldRender = true) {
  try {
    const result = await api.listAdminProducts(state.adminCatalog);
    state.adminCatalog.items = result.items;
    state.adminCatalog.total = result.total;
  } catch (error) {
    setToast(error.message || 'Falha ao carregar produtos administrativos.', 'error');
  }
  if (shouldRender) updateView();
}

async function initialize() {
  if (!api) { renderSetup(); return; }
  try {
    state.session = await api.getSession();
    const currentUser = state.session ? await api.getCurrentUser() : null;
    needsPasswordSetup = Boolean(currentUser?.user_metadata?.requires_password_setup);
    if (state.session && !needsPasswordSetup) await loadAuthenticatedContext();
  } catch (error) { setToast(error.message || 'Falha ao iniciar.', 'error'); }
  state.ready = true;
  state.session ? (needsPasswordSetup ? renderPasswordSetup() : renderShell()) : renderLogin();
  api.onAuthStateChange(async (session, event) => {
    if (session?.access_token === state.session?.access_token) return;
    state.session = session;
    if (session) {
      const currentUser = await api.getCurrentUser();
      needsPasswordSetup = event === 'PASSWORD_RECOVERY' || Boolean(currentUser?.user_metadata?.requires_password_setup);
      if (needsPasswordSetup) { renderPasswordSetup(); return; }
      try { await loadAuthenticatedContext(); renderShell(); }
      catch (error) { setToast(error.message || 'Perfil sem acesso.', 'error'); await api.signOut(); }
    } else { clearPhotoCache(); state.listSelection.clear(); state.profile = null; renderLogin(); }
  });
}

root.addEventListener('submit', async (event) => {
  if (event.target.id === 'set-password-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const password = String(form.get('password') || '');
    const confirmation = String(form.get('confirmation') || '');
    if (password !== confirmation) { setToast('As senhas não coincidem.', 'error'); renderPasswordSetup(); return; }
    state.busy = true; renderPasswordSetup();
    try {
      await api.updatePassword(password);
      needsPasswordSetup = false;
      state.busy = false;
      history.replaceState(null, '', location.pathname);
      navigate('home');
      await loadAuthenticatedContext();
      setToast('Senha criada com sucesso.', 'success');
      renderShell();
    } catch (error) {
      state.busy = false;
      setToast(error.message || 'Não foi possível definir a senha.', 'error');
      renderPasswordSetup();
    }
    return;
  }
  if (event.target.id === 'login-form') {
    event.preventDefault(); state.busy = true; renderLogin();
    const form = new FormData(event.target);
    try { state.session = await api.signIn(String(form.get('email') || ''), String(form.get('password') || '')); await loadAuthenticatedContext(); renderShell(); }
    catch (error) { setToast(error.message || 'Não foi possível entrar.', 'error'); state.busy = false; renderLogin(); }
    return;
  }
  if (event.target.id === 'invite-user-form') {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    try {
      await api.inviteUser(form.email, form.fullName);
      setToast('Convite enviado. O perfil permanecerá inativo até a aprovação.', 'success');
      await loadAdmin();
    } catch (error) { setToast(error.message || 'Não foi possível convidar o usuário.', 'error'); updateView(); }
    return;
  }
  if (event.target.dataset.profileAccess) {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api.setProfileAccess(event.target.dataset.profileAccess, form.getAll('branchIds'), form.getAll('priceTableIds'));
      setToast('Acessos do vendedor atualizados.', 'success');
      await loadAdmin();
    } catch (error) { setToast(error.message || 'Não foi possível atualizar os acessos.', 'error'); updateView(); }
    return;
  }
  if (event.target.id === 'admin-product-search-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    state.adminCatalog.query = String(form.get('query') || '').trim();
    state.adminCatalog.status = String(form.get('status') || 'ATIVOS').toUpperCase();
    state.adminCatalog.page = 1;
    state.adminCatalog.selection.clear();
    await loadAdminProducts();
    return;
  }
  if (!['branch-form', 'price-table-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.target));
  try {
    if (event.target.id === 'branch-form') await api.createBranch(form);
    else await api.createPriceTable(form);
    const context = await api.loadContext(); state.priceTables = context.priceTables; state.lastSync = context.lastSync;
    setToast(event.target.id === 'branch-form' ? 'Filial criada.' : 'Tabela comercial criada.', 'success');
    await loadAdmin();
  } catch (error) { setToast(error.message || 'Não foi possível salvar.', 'error'); updateView(); }
});

root.addEventListener('click', async (event) => {
  if (event.target.id === 'product-photo-dialog') { event.target.close(); return; }
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    navigate(routeButton.dataset.route);
    document.querySelector('.side-nav')?.classList.remove('open');
    if (state.route === 'documents') await loadDocuments(false);
    if (state.route === 'admin') { await loadAdmin(); return; }
    updateView(); return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  const filterSummary = event.target.closest('[data-filter-summary]');
  if (filterSummary) state.openFilter = filterSummary.parentElement.open ? '' : filterSummary.dataset.filterSummary;
  const photoButton = event.target.closest('[data-product-photo]');
  if (photoButton && !photoButton.disabled) { openProductPhoto(photoButton); return; }
  if (action === 'close-product-photo') { document.querySelector('#product-photo-dialog')?.close(); return; }
  if (action === 'photo-zoom-in') { applyPhotoZoom(photoZoom + .5); return; }
  if (action === 'photo-zoom-out') { applyPhotoZoom(photoZoom - .5); return; }
  if (action === 'photo-zoom-reset') { applyPhotoZoom(1); return; }
  if (action === 'select-visible-products') {
    state.products.forEach((product) => state.listSelection.set(product.id, product));
    setToast(`${state.products.length} produto(s) desta página selecionado(s).`, 'success');
    updateView(); return;
  }
  if (action === 'select-admin-page') {
    for (const product of state.adminCatalog.items) {
      if (state.adminCatalog.selection.size >= 500) break;
      state.adminCatalog.selection.add(product.id);
    }
    setToast(`${state.adminCatalog.selection.size} produto(s) selecionado(s).`, 'success');
    updateView(); return;
  }
  if (action === 'clear-admin-selection') {
    state.adminCatalog.selection.clear(); updateView(); return;
  }
  if (action === 'toggle-admin-products') {
    const ids = [...state.adminCatalog.selection];
    if (!ids.length) return;
    const activating = state.adminCatalog.status === 'INATIVOS';
    const verb = activating ? 'reativar' : 'inativar';
    if (!confirm(`Deseja ${verb} ${ids.length} produto(s)?`)) return;
    state.busy = true; updateView();
    try {
      const changed = await api.setProductsActive(ids, activating);
      state.adminCatalog.selection.clear();
      state.adminCatalog.page = 1;
      const [catalogOptions] = await Promise.all([
        api.getCatalogFilterOptions(), loadAdminProducts(false), refreshProducts(false), revalidateCarts(false)
      ]);
      applyCatalogOptions(catalogOptions);
      setToast(`${changed} produto(s) ${activating ? 'reativado(s)' : 'inativado(s)'}.`, 'success');
    } catch (error) {
      setToast(error.message || `Não foi possível ${verb} os produtos.`, 'error');
    } finally {
      state.busy = false; updateView();
    }
    return;
  }
  if (action === 'clear-list-selection') { state.listSelection.clear(); updateView(); return; }
  if (action === 'clear-multi-filter') {
    const filter = event.target.closest('[data-filter-name]').dataset.filterName;
    state.filters[filter] = [];
    state.openFilter = filter;
    if (state.route === 'lists' && state.listMode !== 'custom') state.listMode = 'filtered';
    state.productPage = 1; persistSessionState(); await refreshProducts(); return;
  }
  if (action === 'dismiss-toast') { state.toast = null; updateView(); return; }
  if (action === 'toggle-nav') { document.querySelector('.side-nav')?.classList.toggle('open'); return; }
  if (action === 'sign-out') { clearPhotoCache(); state.listSelection.clear(); await api.signOut(); return; }
  if (action === 'search-products') {
    state.query = document.querySelector('#product-query')?.value.trim() || '';
    if (state.route === 'lists' && state.listMode !== 'custom') state.listMode = 'filtered';
    state.productPage = 1; await refreshProducts(); return;
  }
  const pageButton = event.target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) { state.productPage = Number(pageButton.dataset.page); await refreshProducts(); return; }
  const adminProductPage = event.target.closest('[data-admin-product-page]');
  if (adminProductPage && !adminProductPage.disabled) {
    state.adminCatalog.page = Number(adminProductPage.dataset.adminProductPage);
    await loadAdminProducts(); return;
  }
  const syncRunButton = event.target.closest('[data-sync-run]');
  if (syncRunButton) {
    state.adminSync.selectedRunKey = syncRunButton.dataset.syncRun;
    state.adminSync.page = 1;
    await loadSyncChanges(); return;
  }
  const syncChangePage = event.target.closest('[data-sync-change-page]');
  if (syncChangePage && !syncChangePage.disabled) {
    state.adminSync.page = Number(syncChangePage.dataset.syncChangePage);
    await loadSyncChanges(); return;
  }
  const addButton = event.target.closest('[data-add-product]');
  if (addButton) {
    const product = state.products.find((item) => item.id === addButton.dataset.addProduct);
    const cart = state.carts[addButton.dataset.cart];
    if (product && cart) {
      const existing = cart.find((item) => item.product.id === product.id);
      existing ? existing.quantity += 1 : cart.push({ product, quantity: 1 });
      setToast(`${product.code} adicionado.`, 'success'); updateView();
    }
    return;
  }
  const removeButton = event.target.closest('[data-remove-product]');
  if (removeButton) { state.carts[removeButton.dataset.cart] = state.carts[removeButton.dataset.cart].filter((item) => item.product.id !== removeButton.dataset.removeProduct); updateView(); return; }
  if (action === 'lookup-cnpj') { await handleCnpjLookup(event.target.closest('[data-type]').dataset.type); return; }
  if (action === 'save-document') { await handleSaveDocument(event.target.closest('[data-type]').dataset.type); return; }
  if (action === 'reset-document') {
    const type = event.target.closest('[data-type]').dataset.type;
    state.carts[type] = [];
    state.documentDrafts[type] = { cnpj: '', legalName: '', tradeName: '', clientState: '', notes: '' };
    setToast('Novo rascunho iniciado.', 'success'); updateView(); return;
  }
  if (action === 'export-current') { await handleExportCurrent(event.target.closest('[data-type]').dataset.type, event.target.closest('[data-format]').dataset.format); return; }
  if (action === 'export-list') { await handleListExport(event.target.closest('[data-format]').dataset.format); return; }
  const shortcut = event.target.closest('[data-list-shortcut]')?.dataset.listShortcut;
  if (shortcut) {
    state.listMode = shortcut;
    if (shortcut === 'all') {
      state.query = '';
      state.filters = { category: [], line: [], brand: [], inStockOnly: false };
    } else if (shortcut === 'stock') {
      state.query = '';
      state.filters = { category: [], line: [], brand: [], inStockOnly: true };
    } else if (shortcut === 'category') {
      state.query = '';
      state.filters.line = [];
      state.filters.inStockOnly = false;
      state.openFilter = 'category';
      if (!state.filters.category.length) setToast('Escolha uma ou mais categorias no filtro.', 'info');
    }
    state.productPage = 1; persistSessionState(); await refreshProducts(); return;
  }
  const convertButton = event.target.closest('[data-convert]');
  if (convertButton) {
    if (!confirm('Converter esta cotação em pedido? Preços e disponibilidade serão validados novamente.')) return;
    try { await api.convertQuotation(convertButton.dataset.convert); setToast('Cotação convertida em pedido.', 'success'); await loadDocuments(); }
    catch (error) { setToast(error.message || 'Falha na conversão.', 'error'); updateView(); }
    return;
  }
  const statusButton = event.target.closest('[data-document-id][data-status]');
  if (statusButton) {
    const nextStatus = statusButton.dataset.status;
    if (nextStatus === 'CANCELADO' && !confirm('Cancelar este documento?')) return;
    try { await api.setDocumentStatus(statusButton.dataset.documentId, nextStatus); setToast('Status atualizado.', 'success'); await loadDocuments(); }
    catch (error) { setToast(error.message || 'Falha ao atualizar o status.', 'error'); updateView(); }
    return;
  }
  const savedExportButton = event.target.closest('[data-export-document]');
  if (savedExportButton) {
    await handleSavedDocumentExport(savedExportButton.dataset.exportDocument, savedExportButton.dataset.format);
    return;
  }
  if (action === 'commit-import') { await handleImport(); return; }
  if (action === 'sync-drive') { await handleDriveSync(); return; }
  if (action === 'sync-photos') { await handlePhotoSync(); return; }
  if (action === 'export-sap-validation') { await handleSapValidationExport(); return; }
  const profileButton = event.target.closest('[data-profile-id]');
  if (profileButton) {
    try {
      await api.updateProfile(profileButton.dataset.profileId, { role: profileButton.dataset.role, active: profileButton.dataset.active === 'true' });
      setToast('Permissão atualizada.', 'success'); await loadAdmin();
    } catch (error) { setToast(error.message || 'Falha ao atualizar usuário.', 'error'); updateView(); }
  }
});

root.addEventListener('dblclick', (event) => {
  if (event.target.closest('[data-photo-stage]')) applyPhotoZoom(photoZoom === 1 ? 2 : 1);
});

root.addEventListener('change', async (event) => {
  const contextKey = event.target.dataset.context;
  if (contextKey) {
    state[contextKey] = event.target.value;
    if (contextKey !== 'priceTableId') {
      const resolved = resolveCommercialContext(state.priceTables, state);
      state.originCode = resolved.originCode;
      state.priceTableId = resolved.priceTableId;
    }
    state.listSelection.clear();
    persistSessionState(); state.productPage = 1;
    await refreshProducts(false);
    await revalidateCarts(false);
    if (!state.priceTableId) setToast('Não existe tabela comercial para este destino e filial.', 'error');
    updateView(); return;
  }
  const filter = event.target.dataset.filter;
  if (filter) {
    state.filters[filter] = filter === 'inStockOnly' ? event.target.value === 'true' : event.target.value;
    if (state.route === 'lists' && state.listMode !== 'custom') state.listMode = 'filtered';
    state.productPage = 1; persistSessionState(); await refreshProducts(); return;
  }
  const multiFilterName = event.target.dataset.multiFilter;
  if (multiFilterName) {
    state.filters[multiFilterName] = toggleFilterSelection(state.filters[multiFilterName], event.target.value, event.target.checked);
    state.openFilter = multiFilterName;
    if (state.route === 'lists' && state.listMode !== 'custom') state.listMode = multiFilterName === 'category' && state.filters.category.length ? 'category' : 'filtered';
    state.productPage = 1; persistSessionState(); await refreshProducts(); return;
  }
  const listProductId = event.target.dataset.listProduct;
  if (listProductId) {
    const product = state.products.find((item) => item.id === listProductId);
    if (event.target.checked && product) state.listSelection.set(product.id, product);
    else state.listSelection.delete(listProductId);
    updateView();
    return;
  }
  const adminProductId = event.target.dataset.adminProduct;
  if (adminProductId) {
    if (event.target.checked && state.adminCatalog.selection.size >= 500) {
      setToast('O limite é de 500 produtos por operação.', 'error');
    } else if (event.target.checked) state.adminCatalog.selection.add(adminProductId);
    else state.adminCatalog.selection.delete(adminProductId);
    updateView();
    return;
  }
  if (event.target.id === 'import-file') {
    try {
      const file = event.target.files?.[0];
      const { parseImportFile } = await import('./lib/importer.js');
      const parsed = await parseImportFile(file);
      pendingImport = { fileName: file.name, rows: parsed.rows, kind: parsed.inferredKind, headers: parsed.headers };
      setToast('Arquivo validado localmente.', 'success'); updateView();
    } catch (error) { pendingImport = null; setToast(error.message, 'error'); updateView(); }
  }
});

root.addEventListener('input', (event) => {
  const type = event.target.dataset.draft;
  const field = event.target.dataset.field;
  if (type && field) {
    state.documentDrafts[type][field] = field === 'cnpj' ? onlyDigits(event.target.value) : event.target.value;
    if (field === 'cnpj') event.target.value = formatCnpj(event.target.value);
  }
  const productId = event.target.dataset.cartQuantity;
  const cartType = event.target.dataset.cart;
  if (productId && cartType) {
    const item = state.carts[cartType].find((entry) => entry.product.id === productId);
    if (item) item.quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
  }
});

window.addEventListener('hashchange', async () => {
  state.route = location.hash.slice(1) || 'home';
  if (!state.session) return;
  if (state.route === 'documents') await loadDocuments(false);
  if (state.route === 'admin') { await loadAdmin(); return; }
  updateView();
});

async function handleCnpjLookup(type) {
  const draft = state.documentDrafts[type];
  if (!isValidCnpj(draft.cnpj)) { setToast('CNPJ inválido. Confira os dígitos.', 'error'); updateView(); return; }
  state.busy = true; updateView();
  try {
    const data = config.demoEnabled
      ? { legalName: 'Empresa de demonstração', tradeName: 'Cliente exemplo', state: state.destinationState, cnpj: draft.cnpj }
      : await lookupCnpj(draft.cnpj, { functionUrl: config.cnpjFunctionUrl, accessToken: await api.getAccessToken() });
    Object.assign(draft, { legalName: data.legalName, tradeName: data.tradeName, clientState: data.state });
    setToast('Dados encontrados. Confirme antes de continuar.', 'success');
  } catch (error) { setToast(error.message, 'error'); }
  finally { state.busy = false; updateView(); }
}

async function handleSaveDocument(type) {
  const draft = state.documentDrafts[type]; const cart = state.carts[type];
  if (!state.priceTableId) { setToast('Selecione uma tabela comercial.', 'error'); updateView(); return; }
  if (!isValidCnpj(draft.cnpj) || !draft.legalName.trim()) { setToast('Consulte e confirme o CNPJ e a razão social.', 'error'); updateView(); return; }
  if (!cart.length) { setToast('Adicione ao menos um item.', 'error'); updateView(); return; }
  if (cart.some((item) => item.product.price === null)) { setToast('Há item sem preço na tabela selecionada.', 'error'); updateView(); return; }
  if (type === 'order' && cart.some((item) => item.product.stock_origin === null)) { setToast('O estoque da origem selecionada está sem dados. O pedido não pode ser confirmado.', 'error'); updateView(); return; }
  if (type === 'order' && cart.some((item) => item.quantity > item.product.stock_origin)) { setToast('Há item com quantidade acima do estoque da origem selecionada.', 'error'); updateView(); return; }
  state.busy = true; updateView();
  try {
    const result = await api.saveDocument(type, draft, cart, { destinationState: state.destinationState, originCode: state.originCode, priceTableId: state.priceTableId });
    draft.id = result.id || draft.id;
    setToast(`${type === 'order' ? 'Pedido' : 'Cotação'} salvo(a) como rascunho.`, 'success');
    await loadDocuments(false);
  } catch (error) { setToast(error.message || 'Falha ao salvar.', 'error'); }
  finally { state.busy = false; updateView(); }
}

function exportPayload(type) {
  return { title: type === 'order' ? 'Pedido' : 'Cotação', items: state.carts[type], customer: state.documentDrafts[type], context: { destinationState: state.destinationState, originCode: state.originCode, updatedAt: formatDateTime(state.lastSync?.finished_at || state.lastSync?.started_at) } };
}

async function handleExportCurrent(type, format) {
  const { exportExcel, exportPdf } = await import('./lib/exporters.js');
  const payload = exportPayload(type);
  format === 'pdf' ? exportPdf(payload) : exportExcel(payload);
}
async function handleListExport(format) {
  if (state.listMode === 'category' && !state.filters.category.length) {
    setToast('Escolha uma ou mais categorias antes de exportar.', 'error'); updateView(); return;
  }
  state.busy = true; updateView();
  try {
    const items = state.listMode === 'custom'
      ? [...state.listSelection.values()]
      : await api.searchAllProducts({
        query: state.query,
        destinationState: state.destinationState,
        originCode: state.originCode,
        priceTableId: state.priceTableId,
        category: state.filters.category,
        line: state.filters.line,
        brand: state.filters.brand,
        inStockOnly: state.filters.inStockOnly
      });
    if (!items.length) throw new Error('Nenhum produto corresponde aos filtros selecionados.');
    const { exportExcel, exportPdf } = await import('./lib/exporters.js');
    const filterTitle = [
      state.filters.category.length ? state.filters.category.join(' + ') : '',
      state.filters.line.length ? state.filters.line.join(' + ') : '',
      state.filters.brand.length ? state.filters.brand.join(' + ') : '',
      state.filters.inStockOnly ? 'disponíveis' : ''
    ].filter(Boolean).join(' - ');
    const titleSuffix = state.listMode === 'custom' ? 'personalizada' : (filterTitle || 'completa');
    const payload = { title: `Lista comercial - ${titleSuffix}`, variant: 'commercial-list', items, context: { destinationState: state.destinationState, originCode: state.originCode, lines: COMMERCIAL_LINES } };
    format === 'pdf' ? exportPdf(payload) : exportExcel(payload);
    setToast(`${integer(items.length)} produto(s) exportado(s).`, 'success');
  } catch (error) {
    setToast(error.message || 'Não foi possível gerar a lista.', 'error');
  } finally {
    state.busy = false; updateView();
  }
}

async function handleSapValidationExport() {
  if (!state.priceTableId) {
    setToast('Selecione uma tabela comercial antes de gerar a conferência.', 'error'); updateView(); return;
  }
  state.busy = true; updateView();
  try {
    const items = await api.searchAllProducts({
      query: '',
      destinationState: state.destinationState,
      originCode: state.originCode,
      priceTableId: state.priceTableId,
      category: '',
      line: '',
      brand: '',
      inStockOnly: false
    });
    const { sampleProductsByLine } = await import('./lib/sap-validation.js');
    const sample = sampleProductsByLine(items, 5);
    if (!sample.length) throw new Error('Nenhum produto ativo foi encontrado para a amostragem.');
    const selectedTable = state.priceTables.find((table) => table.id === state.priceTableId);
    const { exportSapValidationExcel } = await import('./lib/exporters.js');
    exportSapValidationExcel({
      items: sample,
      context: {
        destinationState: state.destinationState,
        originCode: state.originCode,
        tableCode: selectedTable?.code || '',
        tableName: selectedTable?.name || '',
        updatedAt: formatDateTime(state.lastSync?.finished_at || state.lastSync?.started_at),
        generatedAt: new Date().toLocaleString('pt-BR'),
        sampleSize: 5
      }
    });
    setToast(`${integer(sample.length)} item(ns) sorteado(s) para conferência manual.`, 'success');
  } catch (error) {
    setToast(error.message || 'Não foi possível gerar a conferência.', 'error');
  } finally {
    state.busy = false; updateView();
  }
}

async function handleSavedDocumentExport(id, format) {
  try {
    const document = await api.getDocument(id);
    const { exportExcel, exportPdf } = await import('./lib/exporters.js');
    const payload = {
      title: `${document.document_type === 'order' ? 'Pedido' : 'Cotação'} ${document.document_number || 'Rascunho'}`,
      items: document.items,
      customer: { legalName: document.customer_legal_name },
      context: {
        destinationState: document.destination_state,
        originCode: document.origin_code,
        updatedAt: formatDateTime(document.created_at)
      }
    };
    format === 'pdf' ? exportPdf(payload) : exportExcel(payload);
  } catch (error) {
    setToast(error.message || 'Não foi possível exportar o documento.', 'error');
    updateView();
  }
}

async function handleImport() {
  if (!pendingImport) return;
  state.busy = true; updateView();
  try {
    const rows = pendingImport.rows.map((row) => ({
      ...row,
      price_table_id: row.price_table_id || state.priceTableId || null,
      origin_code: row.origin_code || state.originCode
    }));
    const result = await api.importRows(pendingImport.kind, pendingImport.fileName, rows);
    if (result?.ok === false) throw new Error(result.error || 'O lote foi rejeitado.');
    setToast(`Importação concluída: ${result.rows_applied ?? result.accepted ?? rows.length} linha(s) aceita(s).`, 'success');
    pendingImport = null;
    const [context, catalogOptions] = await Promise.all([api.loadContext(), api.getCatalogFilterOptions()]);
    state.lastSync = context.lastSync;
    applyCatalogOptions(catalogOptions);
    state.listSelection.clear();
    await refreshProducts(false);
    if (state.route === 'admin') await loadSyncHistory(false);
  }
  catch (error) { setToast(error.message || 'Falha na importação.', 'error'); }
  finally { state.busy = false; updateView(); }
}

async function pollDriveSync(jobId) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const job = await api.getSyncJob(jobId);
    if (!job) continue;
    if (state.adminSummary) state.adminSummary.syncJob = job;
    updateView();
    if (job.status === 'CONCLUIDO') {
      const [context, catalogOptions] = await Promise.all([api.loadContext(), api.getCatalogFilterOptions()]);
      state.lastSync = context.lastSync;
      applyCatalogOptions(catalogOptions);
      state.listSelection.clear();
      clearPhotoCache();
      await refreshProducts(false);
      if (state.route === 'admin') await loadSyncHistory(false);
      setToast('Sincronização concluída.', 'success');
      updateView();
      return;
    }
    if (job.status === 'FALHOU') {
      setToast(job.error_message || 'A sincronização falhou.', 'error');
      updateView();
      return;
    }
  }
  setToast('A sincronização continua em segundo plano. Consulte novamente em alguns minutos.', 'info');
  updateView();
}

async function handleDriveSync() {
  state.busy = true; updateView();
  try {
    const result = await api.requestDriveSync();
    setToast('Sincronização solicitada.', 'success');
    await loadAdmin();
    void pollDriveSync(result.job_id).catch((error) => {
      setToast(error.message || 'Não foi possível acompanhar a sincronização.', 'error');
      updateView();
    });
  } catch (error) {
    setToast(error.message || 'Falha ao solicitar a sincronização.', 'error');
  } finally {
    state.busy = false;
    updateView();
  }
}

async function handlePhotoSync() {
  state.busy = true; updateView();
  try {
    const result = await api.requestPhotoSync();
    if (!result?.job_id) throw new Error('A atualização de fotos não retornou um identificador.');
    setToast('Atualização das fotos pelo site solicitada.', 'success');
    await loadAdmin();
    void pollDriveSync(result.job_id).catch((error) => {
      setToast(error.message || 'Não foi possível acompanhar a atualização das fotos.', 'error');
      updateView();
    });
  } catch (error) {
    setToast(error.message || 'Não foi possível solicitar as fotos pelo site.', 'error');
  } finally {
    state.busy = false;
    updateView();
  }
}

initialize();
