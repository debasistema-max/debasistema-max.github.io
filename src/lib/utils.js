export const STATES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
  'SP', 'SE', 'TO'
];

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function money(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(value || 0));
}

export function integer(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function formatDateTime(value) {
  if (!value) return 'Não informado';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Não informado'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function debounce(callback, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

export function stockLevel(quantity) {
  if (quantity === null || quantity === undefined || quantity === '') return { key: 'unknown', label: 'Sem dados' };
  const value = Number(quantity || 0);
  if (value >= 50) return { key: 'high', label: 'Disponível' };
  if (value > 0) return { key: 'low', label: 'Confirmar' };
  return { key: 'none', label: 'Indisponível' };
}

export function uniqueTextValues(values) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const key = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
    if (!unique.has(key)) unique.set(key, text);
  }
  return [...unique.values()];
}

function splitCommercialValues(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? '').split(/[;|\n\r•]+/))
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function commercialTextKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, '');
}

export function commercialApplicationValues(values) {
  const unique = new Map();
  const trailingYear = /\s*\(?[\u2018\u2019']?\d{2,4}\s*[/\u2013\u2014-]\s*(?:[\u2018\u2019']?\d{2,4}|\.{3})\)?\s*\*?$/;
  for (const value of splitCommercialValues(values)) {
    const application = value.replace(trailingYear, '').trim().replace(/[,:/-]+$/, '').trim();
    if (!application) continue;
    const key = commercialTextKey(application);
    if (key && !unique.has(key)) unique.set(key, application);
  }
  return [...unique.values()];
}

export function commercialYearValues(values) {
  const unique = new Map();
  for (const value of splitCommercialValues(values)) {
    const year = value
      .replace(/[\u2018\u2019']/g, '')
      .replace(/\s*[/\u2013\u2014-]\s*/g, '\u2013')
      .trim();
    if (!year) continue;
    const key = commercialTextKey(year);
    if (key && !unique.has(key)) unique.set(key, year);
  }
  return [...unique.values()];
}

export function safeFileName(value) {
  return String(value || 'debaportal')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function uuid() {
  return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
