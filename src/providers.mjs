import { readFileSync } from 'node:fs';

// These paths were checked against ESPN's own public league inventories.
export const ESPN_PATHS = Object.freeze({
  football: 'football/college-football', basketball: 'basketball/mens-college-basketball',
  'womens-basketball': 'basketball/womens-college-basketball', baseball: 'baseball/college-baseball',
  softball: 'baseball/college-softball', 'mens-volleyball': 'volleyball/mens-college-volleyball',
  'womens-volleyball': 'volleyball/womens-college-volleyball', 'mens-soccer': 'soccer/usa.ncaa.m.1',
  'womens-soccer': 'soccer/usa.ncaa.w.1', 'mens-ice-hockey': 'hockey/mens-college-hockey',
  'womens-ice-hockey': 'hockey/womens-college-hockey', 'mens-lacrosse': 'lacrosse/mens-college-lacrosse',
  'womens-lacrosse': 'lacrosse/womens-college-lacrosse', 'field-hockey': 'field-hockey/womens-college-field-hockey',
  'mens-water-polo': 'water-polo/mens-college-water-polo', 'womens-water-polo': 'water-polo/womens-college-water-polo',
});

let catalog, providers;
function files() {
  catalog ??= JSON.parse(readFileSync(new URL('../catalog/membership.json', import.meta.url), 'utf8'));
  providers ??= JSON.parse(readFileSync(new URL('../catalog/providers.json', import.meta.url), 'utf8'));
  if (catalog.schemaVersion !== 1 || providers.schemaVersion !== 1) throw new Error('Unsupported provider catalog version');
  return { catalog, providers };
}

export function assertCatalogScope(school, sport) {
  const canonical = files().catalog.schools.find(value => value.slug === school?.slug && String(value.ncaaId) === String(school?.ncaaId));
  if (!canonical || canonical.name !== school.name || !canonical.sports.some(value => value.slug === sport)) throw new Error('School or sport is outside the NCAA catalog');
  return canonical;
}

export function resolveProvider(school, sport, provider = 'espn') {
  const canonical = assertCatalogScope(school, sport);
  if (!['espn', '247sports'].includes(provider)) throw new Error('Unknown provider');
  const registry = files().providers;
  const entry = registry.schools[canonical.slug];
  if (!entry || String(entry.ncaaId) !== String(canonical.ncaaId)) throw new Error('Provider catalog school identity mismatch');
  if (provider === '247sports') {
    const match = entry.recruiting;
    if (!match || !match.sports?.includes(sport)) return { status: 'noProvider', provider, reason: 'no-reviewed-recruiting-mapping' };
    if (!/^[a-z0-9-]+$/.test(match.recruitingSlug) || !match.recruitingName) throw new Error('Invalid recruiting provider identity');
    return { ...match, provider, status: 'verified', schoolId: canonical.slug, ncaaId: canonical.ncaaId, sport };
  }
  const match = entry.espn?.[sport];
  if (!match || match.status !== 'verified') return { status: 'noProvider', provider, reason: match?.reason ?? 'no-verified-league-inventory' };
  const league = registry.leagues[sport];
  if (!/^\d+$/.test(match.espnId) || league?.espnPath !== ESPN_PATHS[sport] || match.espnPath !== league.espnPath) throw new Error('Invalid ESPN provider identity');
  return { ...match, provider, schoolId: canonical.slug, ncaaId: canonical.ncaaId, sport, leagueId: league.leagueId, news: league.news ?? null };
}

/** Re-resolve caller supplied scopes; a forged URL, ID, or alias cannot create a fetch target. */
export function requireProvider(school, sport, provider = 'espn', requested = null) {
  const verified = resolveProvider(school, sport, provider);
  if (verified.status !== 'verified') throw new Error('No verified provider for this school and sport');
  const keys = provider === 'espn' ? ['espnId', 'espnPath'] : ['recruitingSlug', 'recruitingName'];
  if (requested && keys.some(key => requested[key] !== verified[key])) throw new Error('Provider scope mismatch');
  return verified;
}
