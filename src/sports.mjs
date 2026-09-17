// Exact labels and explicit official navigation routes determine sport scope.
// Headlines and arbitrary substrings are deliberately not sport classifiers.
const UNGENDERED = new Set(['football', 'baseball', 'softball', 'field hockey', 'beach volleyball', 'stunt', 'acrobatics and tumbling']);
const SHORT = {
  basketball: ['bball', 'bb', 'bkb', '-baskbl'], soccer: ['soc', '-soccer'], volleyball: ['vball', 'vb', '-volley'],
  tennis: ['ten'], golf: ['golf'], lacrosse: ['lax'], fencing: ['fence', 'fen'],
  'cross country': ['xc', 'cross'], 'track and field': ['track', 'tf'],
  'indoor track and field': ['itrack', 'itf'], 'outdoor track and field': ['otrack', 'otf'],
  'swimming and diving': ['swim', 'swim-dive', 'sd'], rowing: ['row', 'crew'],
  'ice hockey': ['ice', 'hockey'], gymnastics: ['gym'], 'water polo': ['polo', 'wp'],
  skiing: ['ski'], wrestling: ['wrest', 'wres'], squash: ['squash'], rugby: ['rugby'],
};

export function normalizeSportLabel(value) {
  if (typeof value !== 'string' || value.length > 200) return '';
  return value.toLowerCase().replace(/^(.*?)\s*\(([mw])\)\s*$/i, (_, label, gender) => `${gender === 'w' ? 'womens' : 'mens'} ${label}`)
    .replace(/[’']/g, '').replace(/&/g, ' and ')
    .replace(/[-_/]/g, ' ').replace(/\b(women|woman|female)\b/g, 'womens')
    .replace(/\b(men|man|male)\b/g, 'mens').replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(mens |womens )?rowing (lightweight|heavyweight|heavy|open)$/, (_, gender = '', weight) => `${gender}${weight === 'heavy' ? 'heavyweight' : weight} rowing`)
    .replace(/^(mens |womens )heavy rowing$/, '$1heavyweight rowing');
}

export function sportGender(sport) {
  const gender = String(sport?.gender ?? '').toLowerCase();
  if (['f', 'w', 'female', 'women', 'womens'].includes(gender)) return 'womens';
  if (['m', 'male', 'men', 'mens'].includes(gender)) return 'mens';
  if (['x', 'mixed', 'coed', 'co-ed'].includes(gender)) return 'coed';
  return normalizeSportLabel(sport?.name).match(/^(womens|mens) /)?.[1]
    ?? normalizeSportLabel(sport?.slug).match(/^(womens|mens) /)?.[1] ?? null;
}

function baseSport(sport) {
  let base = normalizeSportLabel(sport?.name || sport?.slug).replace(/^(mens|womens|mixed|coed) /, '');
  base = base.replace(/^(indoor|outdoor) track$/, '$1 track and field')
    .replace(/^track (indoor|outdoor)$/, '$1 track and field')
    .replace(/^track$/, 'track and field').replace(/^swimming$/, 'swimming and diving')
    .replace(/^swimming diving$/, 'swimming and diving').replace(/^crosscountry$/, 'cross country');
  return base;
}

export function sportAliases(sport) {
  if (!sport || typeof sport !== 'object') return [];
  const gender = sportGender(sport), base = baseSport(sport), values = [];
  const add = value => { const label = normalizeSportLabel(value); if (label) values.push(label); };
  // A label without a gender is safe only for sports whose standard NCAA
  // designation is unambiguous, or for an explicitly ungendered program.
  for (const value of [sport.slug, sport.name]) {
    const label = normalizeSportLabel(value);
    if (!gender || /^(mens|womens|mixed|coed) /.test(label) || UNGENDERED.has(label)) add(value);
  }
  add(sport.code);
  add(`${gender ? `${gender} ` : ''}${base}`);
  if (UNGENDERED.has(base)) add(base);
  if (gender && gender !== 'coed') {
    const prefix = gender === 'womens' ? 'w' : 'm';
    for (const short of SHORT[base] ?? []) add(prefix + short);
    if (base === 'swimming and diving') add(`${gender} swimming`);
    if (base === 'track and field') add(`${gender} track`);
    if (base === 'ice hockey') add(`${gender} hockey`);
    if (base === 'crew') [ `${gender} rowing`, `${prefix}row`, `${prefix}crew` ].forEach(add);
    if (base === 'crew') add(`${gender} heavyweight rowing`);
    if (base === 'rowing') add(`${gender} heavyweight rowing`);
    if (base === 'lightweight crew') [ `${gender} lightweight rowing`, `${prefix}lrow`, `${prefix}lcrew`, `${prefix}lr`, `${prefix}row-l` ].forEach(add);
    if (base === 'lightweight football') [ `${gender} sprint football`, 'sprint football', 'sprint' ].forEach(add);
    if (base === 'synchronized swimming') add(`${gender} artistic swimming`);
    if (base === 'indoor track and field') add(`${gender} indoor track`);
    if (base === 'outdoor track and field') add(`${gender} outdoor track`);
    if (/^(indoor|outdoor) track and field$/.test(base)) {
      add(`${gender} track and field`);
      add(`${gender} track`);
      add(`${prefix}track`);
      add(`${prefix}tf`);
    }
  }
  if (base === 'football') ['fb', 'fball'].forEach(add);
  if (base === 'football') ['m-footbl'].forEach(add);
  if (base === 'baseball') ['base', 'bsb', 'm-basebl'].forEach(add);
  if (base === 'softball') ['soft', 'sball', 'sb', 'w-softbl'].forEach(add);
  for (const value of Array.isArray(sport.aliases) ? sport.aliases.slice(0, 100) : []) add(value);
  return [...new Set(values)];
}

// These are sport families, not headline classifiers. An observed combined
// official program can serve multiple NCAA sponsorship rows (track seasons,
// or a men/women combined team). Basketball and other ambiguous generic labels
// are accepted only when the school has a single matching sponsored program.
export function sportFamily(sport) {
  return baseSport(sport).replace(/^(?:indoor|outdoor) track and field$/, 'track and field')
    .replace(/^(?:heavyweight )?crew$/, 'rowing').replace(/^lightweight crew$/, 'lightweight rowing');
}
const COMBINED_FAMILIES = new Set(['track and field', 'cross country', 'swimming and diving', 'skiing', 'fencing', 'rifle', 'sailing']);
export function matchNavigationSport(label, sport, allSports) {
  if (matchSport(label, sport)) return true;
  let normalized = normalizeSportLabel(label).replace(/^mens and womens |^womens and mens |^m and w /, '');
  normalized = normalized.replace(/^track field$/, 'track and field').replace(/^swimming diving$/, 'swimming and diving')
    .replace(/^swimming$/, 'swimming and diving').replace(/^wrestling$/, 'wrestling')
    .replace(/^acrobatics tumbling$/, 'acrobatics and tumbling');
  const family = sportFamily(sport);
  if (normalized !== family) return false;
  if (COMBINED_FAMILIES.has(family)) return true;
  return allSports.filter(other => sportFamily(other) === family).length === 1;
}

export function matchSport(label, sport) {
  const normalized = normalizeSportLabel(label);
  if (!normalized) return false;
  const aliases = sportAliases(sport);
  if (aliases.includes(normalized)) return true;
  // Sidearm displays an abbreviation followed by a full label, e.g. MSOC
  // (Men's Soccer). Match only a complete parenthetical label.
  const parenthetical = typeof label === 'string' && label.match(/^[A-Za-z0-9 -]{1,20}\(([^()]+)\)$/);
  return !!parenthetical && aliases.includes(normalizeSportLabel(parenthetical[1]));
}

function verifiedRouteSlugs(sport) {
  return (Array.isArray(sport?.routes) ? sport.routes.slice(0, 100) : []).flatMap(route => {
    if (typeof route !== 'string' || route.length > 2048) return [];
    try { const url = new URL(route, 'https://scope.example.org'); return [decodeURIComponent(url.pathname).toLowerCase().match(/^\/sports?\/([^/]+)(?:\/|$)/i)?.[1] ?? url.searchParams.get('path')].filter(Boolean); }
    catch { return []; }
  });
}

export function matchSportRoute(value, sport) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url, path;
  try { url = new URL(value, 'https://scope.example.org'); path = decodeURIComponent(url.pathname).toLowerCase(); }
  catch { return false; }
  const routeSlugs = verifiedRouteSlugs(sport);
  const route = path.match(/^\/sports?\/([^/]+)(?:\/|$)/)?.[1];
  if (route) return routeSlugs.includes(route) || matchSport(route, sport);
  const newsSlug = path.match(/^\/news\/\d{4}\/\d{1,2}\/\d{1,2}\/([^/]+)/)?.[1];
  if (newsSlug) {
    const aliases = [...routeSlugs, ...sportAliases(sport).map(label => label.replaceAll(' ', '-'))];
    return aliases.some(alias => newsSlug === alias || newsSlug.startsWith(`${alias}-`));
  }
  const pathCode = url.searchParams.get('path');
  return !!pathCode && (routeSlugs.includes(pathCode) || matchSport(pathCode, sport));
}
