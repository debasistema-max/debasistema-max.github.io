function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeCommercialLine(value) {
  const normalized = normalizedText(value);
  if (/^(?:u|utilitario|utilitarios)$|\butilit/.test(normalized)) return 'Utilitário';
  if (/^(?:p|pesada|pesado|pesadas|pesados)$|\bpesad/.test(normalized)) return 'Pesada';
  if (/^(?:l|leve|leves)$|\bleve\b|\bpasseio\b/.test(normalized)) return 'Leve';
  return '';
}

function textValues(value) {
  if (value instanceof Map) return [...value.values()].flatMap(textValues);
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === 'object') {
    return [value.application, value.model, value.vehicle, value.description].filter(Boolean);
  }
  return value === null || value === undefined ? [] : [value];
}

export function classifyCommercialLine({
  commercialLine = '', description = '', category = '', applications = [], synonyms = []
} = {}) {
  const explicit = normalizeCommercialLine(commercialLine);
  if (explicit) return explicit;

  const text = normalizedText([
    commercialLine,
    description,
    category,
    ...textValues(applications),
    ...textValues(synonyms)
  ].join(' '));

  const utility = /\b(?:utilitario|pickup|pick up|picape|furg(?:ao)?|van|s ?10|hilux|ranger|amarok|frontier|strada|toro|montana|saveiro|oroch|master|ducato|boxer|jumper|daily|sprinter|bongo|topic|transit|expert|jumpy|scudo|trafic|kangoo|doblo|partner|berlingo)\b/;
  if (utility.test(text)) return 'Utilitário';

  const heavy = /\b(?:pesad[ao]s?|caminh(?:ao|oes)?|onibus|micro onibus|truck|carreta|cavalo mecanico|trator|scania|tector|stralis|hi way|ate[\s-]?go|axor|actros|accelo|constellation|delivery|worker|cargo|agrale|tgx|volvo fh|volvo fm)\b/;
  if (heavy.test(text)) return 'Pesada';

  return 'Leve';
}
