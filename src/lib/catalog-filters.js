export const MULTI_FILTER_SEPARATOR = '\u001f';

export function normalizeFilterSelection(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

export function encodeFilterSelection(value) {
  const selected = normalizeFilterSelection(value);
  return selected.length ? selected.join(MULTI_FILTER_SEPARATOR) : null;
}

export function matchesFilterSelection(value, selected) {
  const filters = normalizeFilterSelection(selected);
  return !filters.length || filters.includes(String(value || '').trim());
}

export function toggleFilterSelection(selected, value, checked) {
  const next = new Set(normalizeFilterSelection(selected));
  if (checked) next.add(String(value || '').trim());
  else next.delete(String(value || '').trim());
  return [...next].filter(Boolean);
}
