function normalizedLine(value) {
  const line = String(value || '').trim();
  return line || 'Sem linha';
}

function lineKey(value) {
  return normalizedLine(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

export function sampleProductsByLine(items, perLine = 5, random = Math.random) {
  const configuredLimits = perLine && typeof perLine === 'object'
    ? new Map(Object.entries(perLine).map(([line, quantity]) => [lineKey(line), Math.max(0, Math.floor(Number(quantity) || 0))]))
    : null;
  const defaultLimit = configuredLimits ? 0 : Math.max(1, Math.floor(Number(perLine) || 5));
  const groups = new Map();

  for (const item of items || []) {
    const code = String(item?.code || item?.product?.code || '').trim();
    if (!code) continue;
    const line = normalizedLine(item?.product_line ?? item?.product?.product_line);
    if (!groups.has(line)) groups.set(line, []);
    groups.get(line).push(item);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'pt-BR'))
    .flatMap(([line, products]) => {
      const limit = configuredLimits?.get(lineKey(line)) ?? defaultLimit;
      if (limit <= 0) return [];
      const shuffled = [...products];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled.slice(0, limit).map((product) => ({ ...product, validation_line: line }));
    });
}
