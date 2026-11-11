const SESSION_KEY = 'debaportal.session-state.v1';

function restoreSessionState() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
  } catch {
    return {};
  }
}

const restored = restoreSessionState();

export const state = {
  ready: false,
  session: null,
  profile: null,
  route: location.hash.slice(1) || 'home',
  destinationState: restored.destinationState || 'SP',
  originCode: restored.originCode || 'SP',
  priceTableId: restored.priceTableId || '',
  priceTables: [],
  catalogOptions: { categories: [], lines: [] },
  lastSync: null,
  products: [],
  productTotal: 0,
  productPage: 1,
  pageSize: 20,
  query: '',
  filters: { category: '', line: '', inStockOnly: false },
  listMode: 'all',
  listSelection: new Map(),
  carts: { order: [], quotation: [] },
  documentDrafts: {
    order: { cnpj: '', legalName: '', tradeName: '', clientState: '', notes: '' },
    quotation: { cnpj: '', legalName: '', tradeName: '', clientState: '', notes: '' }
  },
  documents: [],
  adminSummary: null,
  adminCatalog: {
    items: [], total: 0, page: 1, pageSize: 50,
    query: '', status: 'ATIVOS', selection: new Set()
  },
  busy: false,
  toast: null
};

export function persistSessionState() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    destinationState: state.destinationState,
    originCode: state.originCode,
    priceTableId: state.priceTableId
  }));
}

export function navigate(route) {
  state.route = route;
  if (location.hash !== `#${route}`) location.hash = route;
}

export function setToast(message, type = 'info') {
  state.toast = { message, type, id: Date.now() };
}
