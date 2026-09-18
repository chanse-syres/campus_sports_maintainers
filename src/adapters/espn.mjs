import { cleanText, safeUrl, isoDate, uniqueById, stableId } from '../normalize.mjs';
import { ESPN_PATHS, requireProvider } from '../providers.mjs';
import { cleanAuthor } from './article-metadata.mjs';

export { ESPN_PATHS };
export const teamId = (school, sport, provider) => requireProvider(school, sport, 'espn', provider).espnId;
export function espnUrl(school, sport, collection, provider) {
  const scope = requireProvider(school, sport, 'espn', provider);
  if (!['roster', 'schedule', 'news'].includes(collection)) throw new Error('Invalid ESPN collection');
  if (collection === 'news') {
    if (!scope.news?.sourceUrl) throw new Error('No verified ESPN news feed');
    return scope.news.sourceUrl;
  }
  return `https://site.api.espn.com/apis/site/v2/sports/${scope.espnPath}/teams/${scope.espnId}/${collection}`;
}
function parse(text, expectedId) {
  if (typeof text !== 'string' || text.length > 4_000_000 || !/^\d+$/.test(String(expectedId))) throw new Error('Invalid ESPN document or identity');
  const value = JSON.parse(text);
  if (String(value.team?.id) !== String(expectedId)) throw new Error('Source team mismatch');
  return value;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => cleanText(value, 10000).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function scalar(value, max, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid ESPN news scalar');
  return value;
}

/** Publish bounded headline metadata only, after provider league and team identity checks. */
export function parseEspnNews(text, school, sport, provider, observedAt) {
  const scope = requireProvider(school, sport, 'espn', provider);
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid ESPN observation time');
  if (typeof text !== 'string' || text.length > 4_000_000 || !scope.news) throw new Error('Invalid ESPN news document');
  const data = JSON.parse(text);
  if (!object(data) || data.header !== scope.news.header || data.link?.href !== scope.news.leagueIndexUrl || !Array.isArray(data.articles) || data.articles.length > 200) throw new Error('ESPN news identity mismatch');
  const records = new Map();
  for (const article of data.articles) {
    if (!object(article) || !Array.isArray(article.categories) || article.categories.length > 200 || (article.images != null && (!Array.isArray(article.images) || article.images.length > 20))) throw new Error('Invalid ESPN news record');
    const title = cleanText(scalar(article.headline, 200_000), 300);
    const description = cleanText(scalar(article.description, 200_000, true), 2000);
    const url = safeUrl(scalar(article.links?.web?.href, 2048));
    const rawDate = scalar(article.published, 80, true);
    const publishedAt = /(?:Z|[+-]\d\d:\d\d)$/i.test(rawDate) ? isoDate(rawDate) : null;
    const categories = article.categories;
    if (categories.some(category => !object(category))) throw new Error('Invalid ESPN news category');
    const hasLeague = categories.some(category => category.type === 'league' && String(category.leagueId) === String(scope.leagueId) && String(category.league?.id) === String(scope.leagueId));
    const hasTeam = categories.some(category => category.type === 'team' && String(category.teamId ?? category.team?.id) === scope.espnId && (category.leagueId == null || String(category.leagueId) === String(scope.leagueId)));
    const content = ` ${normalized(`${title} ${description}`)} `;
    const mentionsSchool = [scope.espnName, school.name, ...(scope.verifiedNameAliases ?? [])].some(name => { const alias = normalized(name); return alias.length >= 3 && content.includes(` ${alias} `); });
    if (!hasLeague || !hasTeam || !mentionsSchool || !title || !url || !['www.espn.com', 'espn.com'].includes(new URL(url).hostname)) continue;
    if (publishedAt && Date.parse(publishedAt) > Date.parse(observedAt) + 86_400_000) continue;
    let imageUrl = null, imageAlt = null;
    for (const entry of article.images ?? []) {
      if (!object(entry)) throw new Error('Invalid ESPN news image');
      const candidate = safeUrl(scalar(entry.url, 2048));
      if (candidate && ['a.espncdn.com', 'espnmedia-cdn.akamaized.net'].includes(new URL(candidate).hostname)) {
        imageUrl = candidate;
        imageAlt = cleanText(scalar(entry.alt ?? entry.caption, 200_000, true), 300) || null;
        break;
      }
    }
    records.set(url, { id: stableId(school.slug, sport, url), title, url, publishedAt, publishedAtPrecision: publishedAt ? 'instant' : 'unknown', imageUrl, imageAlt,author:cleanAuthor(article.byline), publisher: 'ESPN', discoverySourceUrl: scope.news.sourceUrl });
  }
  return { records: [...records.values()].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')), emptyConfirmed: true, season: null, reason: 'publisher-feed-filtered-verified-school-and-sport' };
}

export async function collectEspn({ school, sport, kind, provider, observedAt, get }) {
  if (typeof get !== 'function') throw new Error('ESPN fetch function is required');
  const scope = requireProvider(school, sport, 'espn', provider);
  const sourceUrl = espnUrl(school, sport, kind, scope);
  const text = await get(sourceUrl);
  const result = kind === 'news' ? parseEspnNews(text, school, sport, scope, observedAt) : kind === 'roster' ? parseRoster(text, scope.espnId) : parseSchedule(text, scope.espnId);
  return { ...result, sourceUrl, scope: { schoolId: school.slug, ncaaId: school.ncaaId, sport, espnId: scope.espnId, inventorySourceUrl: scope.sourceUrl } };
}
const externalLink = links => safeUrl(links?.find(l => l.rel?.includes('desktop') && l.href?.startsWith('https://www.espn.com/'))?.href);
const score = value => { const n = Number(value?.value ?? value); return value != null && value !== '' && Number.isFinite(n) && n >= 0 && n < 1000 ? n : null; };
export function parseSchedule(text, expectedId) {
  const data = parse(text, expectedId);
  if (!Array.isArray(data.events) || data.events.length > 400) throw new Error('Invalid schedule');
  const records = data.events.map(event => {
    const competition = event.competitions?.[0];
    const own = competition?.competitors?.find(c => String(c.team?.id) === String(expectedId));
    const other = competition?.competitors?.find(c => String(c.team?.id) !== String(expectedId));
    const id = cleanText(event.id, 80), date = isoDate(event.date), name = cleanText(event.name), opponent = cleanText(other?.team?.displayName);
    if (!own || !id || !date || !name || !opponent || !/(?:Z|[+-]\d\d:\d\d)$/i.test(event.date)) throw new Error('Invalid event scope');
    const datePrecision = competition.timeValid === false || event.timeValid === false ? 'day' : 'instant';
    return { id, date, datePrecision, name, status: cleanText(competition.status?.type?.description || event.status?.type?.description || 'Scheduled', 80), venue: cleanText(competition.venue?.fullName) || null, homeAway: competition.neutralSite ? 'neutral' : ['home', 'away'].includes(own.homeAway) ? own.homeAway : null, opponent, teamScore: score(own.score), opponentScore: score(other.score), url: externalLink(event.links) };
  });
  return { season: cleanText(data.season?.displayName || data.season?.year, 40) || null, records: uniqueById(records).sort((a, b) => a.date.localeCompare(b.date)) };
}
export function parseRoster(text, expectedId) {
  const data = parse(text, expectedId);
  if (!Array.isArray(data.athletes)) throw new Error('Invalid roster');
  const athletes = data.athletes.flatMap(group => Array.isArray(group.items) ? group.items : [group]);
  if (athletes.length > 300) throw new Error('Roster too large');
  const records = athletes.map(player => {
    const id = cleanText(player.id, 80), name = cleanText(player.displayName || player.fullName, 160);
    if (!id || !name) throw new Error('Invalid athlete');
    return { id, name, position: cleanText(player.position?.abbreviation, 30) || null, jersey: cleanText(player.jersey, 10) || null, year: cleanText(player.experience?.displayValue, 40) || null, imageUrl: safeUrl(player.headshot?.href), url: externalLink(player.links) };
  });
  return { season: cleanText(data.season?.displayName || data.season?.year, 40) || null, records: uniqueById(records) };
}
