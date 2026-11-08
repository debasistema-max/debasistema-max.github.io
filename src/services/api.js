import { createClient } from '@supabase/supabase-js';
import { config, hasSupabaseConfig } from '../config.js';
import { uuid } from '../lib/utils.js';

const demoProducts = [
  { id: 'p1', code: 'DP-1001', description: 'Amortecedor dianteiro', applications: ['Veículo compacto 2018 a 2024'], category: 'Suspensão', product_line: 'Amortecedores', price: 289.9, stock_pr: 86, stock_sp: 42, total_stock: 128 },
  { id: 'p2', code: 'DP-1020', description: 'Kit de suspensão traseira', applications: ['Utilitário leve 2019 a 2025'], category: 'Suspensão', product_line: 'Kits', price: 419.5, stock_pr: 12, stock_sp: 4, total_stock: 16 },
  { id: 'p3', code: 'DP-2044', description: 'Terminal de direção', applications: ['Sedã médio 2016 a 2023'], category: 'Direção', product_line: 'Terminais', price: 98.75, stock_pr: 0, stock_sp: 0, total_stock: 0 },
  { id: 'p4', code: 'DP-3108', description: 'Bieleta estabilizadora', applications: ['SUV compacto 2020 a 2026'], category: 'Suspensão', product_line: 'Bieletas', price: 74.2, stock_pr: 31, stock_sp: 55, total_stock: 86 },
  { id: 'p5', code: 'DP-4400', description: 'Coxim superior', applications: ['Hatch 2015 a 2022'], category: 'Suspensão', product_line: 'Coxins', price: 132, stock_pr: 8, stock_sp: 0, total_stock: 8 }
];

function normalizeProduct(row) {
  const nullableNumber = (value) => value === null || value === undefined || value === '' ? null : Number(value);
  return {
    id: row.id || row.product_id,
    code: row.code || row.codigo || '',
    description: row.description || row.descricao || '',
    applications: Array.isArray(row.applications) ? row.applications : [row.application || row.aplicacao || ''].filter(Boolean),
    category: row.category || row.categoria || '',
    product_line: row.product_line || row.linha || '',
    price: nullableNumber(row.price ?? row.preco),
    stock_pr: nullableNumber(row.stock_pr ?? row.estoque_pr),
    stock_sp: nullableNumber(row.stock_sp ?? row.estoque_sp),
    stock_origin: nullableNumber(row.stock_origin ?? row.estoque_origem),
    total_stock: nullableNumber(row.total_stock ?? row.stock_total),
    price_table_id: row.price_table_id || null,
    updated_at: row.updated_at || null
  };
}

class SupabaseApi {
  constructor() {
    this.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  async getSession() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async getCurrentUser() {
    const { data, error } = await this.client.auth.getUser();
    if (error) throw error;
    return data.user;
  }

  onAuthStateChange(callback) {
    return this.client.auth.onAuthStateChange((event, session) => callback(session, event));
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async updatePassword(password) {
    if (String(password || '').length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
    const { data, error } = await this.client.auth.updateUser({
      password,
      data: { requires_password_setup: false }
    });
    if (error) throw error;
    return data.user;
  }

  async getProfile() {
    const session = await this.getSession();
    if (!session?.user?.id) throw new Error('Sessão inválida ou expirada.');
    const { data, error } = await this.client
      .from('profiles')
      .select('id,email,full_name,role,active')
      .eq('id', session.user.id)
      .single();
    if (error) throw error;
    if (!data.active) throw new Error('Usuário desativado.');
    return data;
  }

  async getAccessToken() { return (await this.getSession())?.access_token || ''; }

  async getProductImage(code) {
    const session = await this.getSession();
    if (!session?.access_token) throw new Error('Sessão inválida ou expirada.');
    const response = await fetch(`${config.supabaseUrl}/functions/v1/product-image?code=${encodeURIComponent(code)}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: config.supabaseAnonKey,
        Accept: 'image/webp,image/png,image/jpeg'
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(response.status === 401 ? 'Sessão inválida ou expirada.' : 'Foto temporariamente indisponível.');
    const type = String(response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
    if (!['image/webp', 'image/png', 'image/jpeg'].includes(type)) throw new Error('Formato de foto inválido.');
    const blob = await response.blob();
    if (!blob.size || blob.size > 5_000_000) throw new Error('Foto fora do limite permitido.');
    return blob;
  }

  async loadContext() {
    const [tablesResult, syncResult] = await Promise.all([
      this.client.from('price_tables').select('id,code,name,destination_state,version,valid_from,valid_to,active,origin_branch:branches!price_tables_origin_branch_id_fkey(code)').eq('active', true).order('name'),
      this.client.from('sync_metadata').select('source_kind,source_name,status,finished_at,started_at,rows_received,rows_applied,error_count,error_message').order('started_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (tablesResult.error) throw tablesResult.error;
    if (syncResult.error) throw syncResult.error;
    return {
      priceTables: (tablesResult.data || []).map((table) => ({ ...table, origin_code: table.origin_branch?.code || null })),
      lastSync: syncResult.data ? { ...syncResult.data, source: syncResult.data.source_name || syncResult.data.source_kind } : null
    };
  }

  async searchProducts(params) {
    const { data, error } = await this.client.rpc('search_catalog', {
      search_text: params.query || null,
      destination_state: params.destinationState || null,
      origin_code: params.originCode || null,
      price_table_id: params.priceTableId || null,
      category_filter: params.category || null,
      line_filter: params.line || null,
      in_stock_only: Boolean(params.inStockOnly),
      page_number: params.page || 1,
      page_size: params.pageSize || 20
    });
    if (error) throw error;
    const rows = Array.isArray(data) ? data : (data?.items || []);
    return { items: rows.map(normalizeProduct), total: Number(data?.total ?? rows[0]?.total_count ?? rows.length) };
  }

  async searchAllProducts(params, maxItems = 10000) {
    const pageSize = 100;
    const first = await this.searchProducts({ ...params, page: 1, pageSize });
    if (first.total > maxItems) throw new Error(`A lista excede o limite de ${maxItems.toLocaleString('pt-BR')} itens.`);
    const items = [...first.items];
    const totalPages = Math.ceil(first.total / pageSize);
    for (let start = 2; start <= totalPages; start += 5) {
      const pages = Array.from({ length: Math.min(5, totalPages - start + 1) }, (_, index) => start + index);
      const results = await Promise.all(pages.map((page) => this.searchProducts({ ...params, page, pageSize })));
      results.forEach((result) => items.push(...result.items));
    }
    return items;
  }

  async getCatalogFilterOptions() {
    const rows = [];
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await this.client.from('products')
        .select('category,product_line').eq('active', true).range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const values = (key) => [...new Set(rows.map((row) => String(row[key] || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { categories: values('category'), lines: values('product_line') };
  }

  async saveDocument(type, draft, items, context) {
    const { data, error } = await this.client.rpc('save_commercial_document', {
      document_payload: {
        id: draft.id || null,
        document_type: type === 'order' ? 'PEDIDO' : 'COTACAO',
        destination_state: context.destinationState,
        origin_code: context.originCode,
        price_table_id: context.priceTableId || null,
        customer_cnpj: draft.cnpj,
        customer_name: draft.legalName,
        customer_state: draft.clientState || null,
        notes: draft.notes || null,
        status: 'RASCUNHO'
      },
      items_payload: items.map((item) => ({
        product_id: item.product.id,
        quantity: Number(item.quantity)
      }))
    });
    if (error) throw error;
    return { id: data, document_number: '' };
  }

  async listDocuments(type) {
    let query = this.client.from('commercial_documents')
      .select('id,document_number,document_type,status,customer_name,customer_cnpj,total,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(50);
    if (type) query = query.eq('document_type', type);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map((row) => ({
      ...row,
      document_type: row.document_type === 'PEDIDO' ? 'order' : 'quotation',
      customer_legal_name: row.customer_name,
      total_amount: row.total
    }));
  }

  async getDocument(id) {
    const { data, error } = await this.client
      .from('commercial_documents')
      .select('id,document_number,document_type,status,destination_state,price_table_code_snapshot,price_table_version_snapshot,customer_name,customer_cnpj,customer_state,notes,total,created_at,origin_branch:branches!commercial_documents_origin_branch_id_fkey(code),commercial_document_items(id,line_number,product_code_snapshot,description_snapshot,application_snapshot,quantity,unit_price,line_total,stock_snapshot)')
      .eq('id', id)
      .single();
    if (error) throw error;
    return {
      ...data,
      document_type: data.document_type === 'PEDIDO' ? 'order' : 'quotation',
      customer_legal_name: data.customer_name,
      total_amount: data.total,
      origin_code: data.origin_branch?.code || '',
      items: (data.commercial_document_items || [])
        .sort((a, b) => a.line_number - b.line_number)
        .map((item) => ({
          code: item.product_code_snapshot,
          description: item.description_snapshot,
          applications: [item.application_snapshot].filter(Boolean),
          quantity: Number(item.quantity),
          price: Number(item.unit_price),
          total: Number(item.line_total),
          stock_origin: Number(item.stock_snapshot || 0)
        }))
    };
  }

  async convertQuotation(id) {
    const { data, error } = await this.client.rpc('convert_quotation_to_order', { quotation_id: id });
    if (error) throw error;
    return data;
  }

  async setDocumentStatus(id, status) {
    const { data, error } = await this.client.rpc('set_commercial_document_status', { document_id: id, new_status: status });
    if (error) throw error;
    return data;
  }

  async importRows(kind, sourceName, rows) {
    const kindMap = { catalog: 'PRODUTOS', prices: 'PRECOS', stock: 'ESTOQUE', complete: 'COMPLETO' };
    const { data, error } = await this.client.rpc('import_catalog_batch', { import_kind: kindMap[kind] || String(kind).toUpperCase(), source_name: sourceName, rows });
    if (error) throw error;
    return data;
  }

  async storageSummary() {
    const { data, error } = await this.client.rpc('storage_summary');
    if (error) throw error;
    if (!data) return [];
    return [
      { relation: 'Banco de dados', bytes: data.database_bytes, pretty_size: `${(Number(data.database_bytes || 0) / 1024 / 1024).toFixed(1)} MB` },
      { relation: 'Produtos', pretty_size: `${Number(data.products || 0).toLocaleString('pt-BR')} registros` },
      { relation: 'Documentos', pretty_size: `${Number(data.documents || 0).toLocaleString('pt-BR')} registros` },
      ...Object.entries(data.tables || {}).sort(([a], [b]) => a.localeCompare(b)).map(([relation, bytes]) => ({ relation, bytes, pretty_size: `${(Number(bytes || 0) / 1024).toFixed(1)} KB` }))
    ];
  }

  async listProfiles() {
    const { data, error } = await this.client
      .from('profiles')
      .select('id,email,full_name,role,active,created_at,profile_branch_access(branch_id),profile_price_table_access(price_table_id)')
      .order('full_name');
    if (error) throw error;
    return (data || []).map((profile) => ({
      ...profile,
      branch_ids: (profile.profile_branch_access || []).map((row) => row.branch_id),
      price_table_ids: (profile.profile_price_table_access || []).map((row) => row.price_table_id)
    }));
  }

  async listBranches() {
    const { data, error } = await this.client.from('branches').select('id,code,name,state,active').order('code');
    if (error) throw error;
    return data || [];
  }

  async createBranch(payload) {
    const { data, error } = await this.client.from('branches').insert({
      code: String(payload.code || '').trim().toUpperCase(),
      name: String(payload.name || '').trim(),
      state: String(payload.state || '').trim().toUpperCase(),
      active: true
    }).select('id,code,name,state,active').single();
    if (error) throw error;
    return data;
  }

  async createPriceTable(payload) {
    const { data, error } = await this.client.from('price_tables').insert({
      code: String(payload.code || '').trim().toUpperCase(),
      name: String(payload.name || '').trim(),
      version: Number(payload.version || 1),
      destination_state: payload.destinationState || null,
      origin_branch_id: payload.originBranchId || null,
      valid_from: payload.validFrom || new Date().toISOString().slice(0, 10),
      active: true
    }).select('id,code,name,version,destination_state,active').single();
    if (error) throw error;
    return data;
  }

  async updateProfile(id, patch) {
    const { data, error } = await this.client.from('profiles').update({
      role: patch.role,
      active: Boolean(patch.active)
    }).eq('id', id).select('id,full_name,role,active,created_at').single();
    if (error) throw error;
    return data;
  }

  async setProfileAccess(id, branchIds, priceTableIds) {
    const { error } = await this.client.rpc('set_profile_access', {
      target_profile_id: id,
      branch_ids: branchIds,
      price_table_ids: priceTableIds
    });
    if (error) throw error;
  }

  async inviteUser(email, fullName) {
    const { data, error } = await this.client.functions.invoke('admin-users', {
      body: { email: String(email || '').trim().toLowerCase(), full_name: String(fullName || '').trim() }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data?.data || data;
  }

  async requestDriveSync() {
    const { data, error } = await this.client.functions.invoke('sync-onedrive', { body: { action: 'dispatch' } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data?.data || data;
  }

  async getSyncJob(id = null) {
    const { data, error } = await this.client.rpc('get_sync_job', { sync_job_id: id });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] || null) : data;
  }

}

class DemoApi {
  constructor() { this.documents = []; this.callbacks = []; }
  async getSession() { return null; }
  async getCurrentUser() { return this.session?.user || null; }
  onAuthStateChange(callback) { this.callbacks.push(callback); return { data: { subscription: { unsubscribe() {} } } }; }
  async signIn(email, password) {
    if (!email || password.length < 6) throw new Error('No modo demonstração, informe e-mail e uma senha com 6 caracteres.');
    const session = { access_token: 'demo', user: { id: 'demo-user', email } };
    this.session = session;
    this.callbacks.forEach((callback) => callback(session));
    return session;
  }
  async signOut() { this.session = null; this.callbacks.forEach((callback) => callback(null)); }
  async updatePassword() { return true; }
  async getProfile() { return { id: 'demo-user', full_name: 'Demonstração', role: 'ADMIN', active: true, allowed_states: [], allowed_origins: [] }; }
  async getAccessToken() { return 'demo'; }
  async getProductImage() { return null; }
  async loadContext() {
    return { priceTables: [
      { id: 'demo-sp', code: 'SP-PADRAO', name: 'Tabela padrão SP', destination_state: 'SP', origin_code: 'SP', version: 1, active: true },
      { id: 'demo-pr', code: 'PR-PADRAO', name: 'Tabela padrão PR', destination_state: 'PR', origin_code: 'PR', version: 1, active: true }
    ], lastSync: { source: 'Dados fictícios', status: 'success', finished_at: new Date().toISOString(), summary: { products: demoProducts.length } } };
  }
  async searchProducts(params) {
    const term = String(params.query || '').toLowerCase();
    const filtered = demoProducts.filter((product) => {
      const haystack = [product.code, product.description, product.category, product.product_line, ...product.applications].join(' ').toLowerCase();
      const originStock = params.originCode === 'PR' ? product.stock_pr : product.stock_sp;
      return (!term || haystack.includes(term)) && (!params.category || product.category === params.category)
        && (!params.line || product.product_line === params.line) && (!params.inStockOnly || originStock > 0);
    });
    const start = ((params.page || 1) - 1) * (params.pageSize || 20);
    return {
      items: filtered.slice(start, start + (params.pageSize || 20)).map((row) => normalizeProduct({
        ...row,
        stock_origin: params.originCode === 'PR' ? row.stock_pr : row.stock_sp
      })),
      total: filtered.length
    };
  }
  async searchAllProducts(params) {
    const result = await this.searchProducts({ ...params, page: 1, pageSize: 10000 });
    return result.items;
  }
  async getCatalogFilterOptions() {
    const values = (key) => [...new Set(demoProducts.map((row) => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { categories: values('category'), lines: values('product_line') };
  }
  async saveDocument(type, draft, items, context) {
    const total = items.reduce((sum, item) => sum + item.quantity * item.product.price, 0);
    const existing = draft.id ? this.documents.find((item) => item.id === draft.id) : null;
    if (existing) {
      Object.assign(existing, { customer_legal_name: draft.legalName, customer_cnpj: draft.cnpj, total_amount: total, items, updated_at: new Date().toISOString() });
      return existing;
    }
    const document = { id: uuid(), document_number: `${type === 'order' ? 'PED' : 'COT'}-${String(this.documents.length + 1).padStart(5, '0')}`,
      document_type: type, status: 'draft', customer_legal_name: draft.legalName, customer_cnpj: draft.cnpj,
      total_amount: total, created_at: new Date().toISOString(), destination_state: context.destinationState,
      origin_code: context.originCode, items };
    this.documents.unshift(document);
    return document;
  }
  async listDocuments(type) { return type ? this.documents.filter((item) => item.document_type === type) : this.documents; }
  async getDocument(id) {
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error('Documento não encontrado.');
    return {
      ...document,
      origin_code: document.origin_code || '',
      items: (document.items || []).map((item) => ({
        code: item.product.code,
        description: item.product.description,
        applications: item.product.applications,
        quantity: item.quantity,
        price: item.product.price,
        stock_pr: item.product.stock_pr,
        stock_sp: item.product.stock_sp,
        stock_origin: item.product.stock_origin
      }))
    };
  }
  async convertQuotation(id) {
    const quotation = this.documents.find((item) => item.id === id);
    if (!quotation) throw new Error('Cotação não encontrada.');
    const order = { ...quotation, id: uuid(), document_type: 'order', document_number: `PED-${String(this.documents.length + 1).padStart(5, '0')}`, created_at: new Date().toISOString() };
    this.documents.unshift(order); return order;
  }
  async setDocumentStatus(id, status) {
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error('Documento não encontrado.');
    document.status = status;
    if (status === 'GERADO' && !document.document_number) {
      document.document_number = `${document.document_type === 'order' ? 'PED' : 'COT'}-${String(this.documents.indexOf(document) + 1).padStart(5, '0')}`;
    }
    return document.document_number;
  }
  async importRows(_kind, sourceName, rows) { return { source: sourceName, accepted: rows.length, rejected: 0, demo: true }; }
  async storageSummary() { return [{ relation: 'demo', bytes: 0, pretty_size: '0 bytes', row_count: demoProducts.length }]; }
  async listProfiles() { return [{ id: 'demo-user', email: 'demo@debaportal.local', full_name: 'Demonstração', role: 'ADMIN', active: true, branch_ids: [], price_table_ids: [], created_at: new Date().toISOString() }]; }
  async listBranches() { return [{ id: 'branch-sp', code: 'SP', name: 'Filial SP', state: 'SP', active: true }, { id: 'branch-pr', code: 'PR', name: 'Filial PR', state: 'PR', active: true }]; }
  async createBranch(payload) { return { id: uuid(), ...payload, active: true }; }
  async createPriceTable(payload) { return { id: uuid(), ...payload, active: true }; }
  async updateProfile(id, patch) { return { id, full_name: 'Demonstração', ...patch }; }
  async setProfileAccess() { return true; }
  async inviteUser(email, fullName) { return { email, full_name: fullName, demo: true }; }
  async requestDriveSync() { return { queued: true, job_id: 'demo-sync', status: 'SOLICITADO' }; }
  async getSyncJob() { return { id: 'demo-sync', status: 'CONCLUIDO', summary: { produtos: 5, precos: 5, estoque: 5 }, finished_at: new Date().toISOString() }; }
}

export const api = config.demoEnabled ? new DemoApi() : (hasSupabaseConfig() ? new SupabaseApi() : null);
export { normalizeProduct };
