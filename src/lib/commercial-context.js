function normalized(value) {
  return String(value || '').trim().toUpperCase();
}

export function tableSupportsContext(table, destinationState, originCode) {
  const destination = normalized(destinationState);
  const origin = normalized(originCode);
  const tableDestination = normalized(table?.destination_state);
  const tableOrigin = normalized(table?.origin_code);
  return (!tableDestination || tableDestination === destination)
    && (!tableOrigin || tableOrigin === origin);
}

export function choosePriceTable(tables, destinationState, originCode, preferredId = '') {
  const candidates = (tables || []).filter((table) => tableSupportsContext(table, destinationState, originCode));
  const preferred = candidates.find((table) => table.id === preferredId);
  if (preferred) return preferred;
  return candidates.sort((left, right) => {
    const specificity = (table) => Number(Boolean(table.destination_state)) + Number(Boolean(table.origin_code));
    return specificity(right) - specificity(left) || Number(right.version || 0) - Number(left.version || 0);
  })[0] || null;
}

export function allowedOrigins(tables, destinationState, knownOrigins = ['PR', 'SP']) {
  const destination = normalized(destinationState);
  const scoped = (tables || []).filter((table) => {
    const tableDestination = normalized(table.destination_state);
    return !tableDestination || tableDestination === destination;
  });
  const explicit = scoped.map((table) => normalized(table.origin_code)).filter(Boolean);
  const candidates = scoped.some((table) => !normalized(table.origin_code))
    ? [...explicit, ...knownOrigins.map(normalized)]
    : explicit;
  return [...new Set(candidates)].sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

export function resolveCommercialContext(tables, context) {
  const origins = allowedOrigins(tables, context.destinationState);
  const originCode = origins.includes(normalized(context.originCode))
    ? normalized(context.originCode)
    : (origins[0] || normalized(context.originCode));
  const table = choosePriceTable(tables, context.destinationState, originCode, context.priceTableId);
  return { originCode, priceTableId: table?.id || '', origins };
}
