function normalizedCategory(value) {
  const category = String(value || '').trim();
  return category || 'Sem categoria';
}

export function sampleProductsByCategory(items, perCategory = 5, random = Math.random) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(perCategory) || 5)));
  const groups = new Map();

  for (const item of items || []) {
    const code = String(item?.code || item?.product?.code || '').trim();
    if (!code) continue;
    const category = normalizedCategory(item?.category ?? item?.product?.category);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'pt-BR'))
    .flatMap(([category, products]) => {
      const shuffled = [...products];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled.slice(0, limit).map((product) => ({ ...product, validation_category: category }));
    });
}
