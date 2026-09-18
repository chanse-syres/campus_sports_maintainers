import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';
import { cleanAuthor } from './article-metadata.mjs';

const membership = JSON.parse(readFileSync(new URL('../../catalog/membership.json', import.meta.url), 'utf8'));
const registry = JSON.parse(readFileSync(new URL('../../catalog/news-feeds.json', import.meta.url), 'utf8'));
const providers = JSON.parse(readFileSync(new URL('../../catalog/providers.json', import.meta.url), 'utf8'));
const normalize = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const phrase = value => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')}\\b`, 'g');
const ambiguous = new Set(['usc', 'osu', 'asu', 'isu', 'msu', 'miami', 'columbia', 'brown', 'ut', 'uc', 'ui', 'mu', 'lu', 'cu', 'su', 'tu', 'um']);
const strongDefinitions = new Map();
const definitions = new Map(membership.schools.map(school => {
  const names = [school.name], strongNames = [school.name];
  const records = providers.schools[school.slug]?.espn ?? {};
  for (const [sport, provider] of Object.entries(records)) if (provider.status === 'verified') {
    names.push(provider.espnName, ...(provider.verifiedNameAliases ?? []));
    const team = providers.leagues[sport]?.teams?.find(team => team.id === provider.espnId);
    if (team) { names.push(team.displayName); strongNames.push(team.displayName); }
  }
  // Full canonical names remain usable when a public provider has no mapping.
  const aliases = [...new Set(names.map(normalize).filter(name => name.length >= 3 && !ambiguous.has(name)))];
  strongDefinitions.set(school.slug, new Set(strongNames.map(normalize)));
  return [school.slug, aliases];
}));
const aliasOwners = new Map();
for (const [slug, aliases] of definitions) for (const alias of aliases) {
  if (!aliasOwners.has(alias)) aliasOwners.set(alias, new Set());
  aliasOwners.get(alias).add(slug);
}
const allAliases = [...aliasOwners.keys()].sort((a, b) => b.length - a.length);
const PROFESSIONAL = /\b(?:nfl|nba|wnba|mlb|nhl|mls|nwsl|super bowl|world series champion|fantasy football|fantasy basketball)\b/;
const BETTING = /\b(?:betting|sportsbook|parlay|moneyline|point spread|over under|best bets|betting odds|picks and predictions|promo code|bonus bets)\b/;
const WOMEN = /\b(?:women s|womens|women|wbb|wbkb|ncaaw|ladies|lady|girls)\b/;
const MEN = /\b(?:men s|mens|men|mbb|mbkb|ncaam|boys)\b/;
const mentionCache = new Map();
const allPrograms = { sports: [...new Map(membership.schools.flatMap(school => school.sports).map(sport => [sport.slug, sport])).values()] };

function canonical(school, sport) {
  const value = membership.schools.find(value => value.slug === school?.slug && value.ncaaId === school?.ncaaId && value.name === school?.name);
  const program = value?.sports.find(value => value.slug === sport?.slug && value.code === sport?.code);
  if (!value || !program) throw new Error('News school or sport is outside the NCAA catalog');
  return { school: value, sport: program };
}

/** Longest complete school names win: Arizona State never supplies Arizona evidence. */
function schoolsMentioned(value, requireStrong = false) {
  let text = normalize(value);
  const key = `${requireStrong ? 'strong' : 'title'}:${text}`;
  if (mentionCache.has(key)) return mentionCache.get(key);
  const matches = new Set();
  for (const alias of allAliases) {
    const expression = phrase(alias);
    if (!expression.test(text)) continue;
    const owners = aliasOwners.get(alias);
    if (owners.size === 1) {
      const slug = [...owners][0];
      if (!requireStrong || strongDefinitions.get(slug).has(alias)) matches.add(slug);
    }
    text = text.replace(phrase(alias), ' ');
  }
  if (mentionCache.size >= 10000) mentionCache.clear();
  mentionCache.set(key, matches);
  return matches;
}

function sportTerms(sport) {
  const slug = sport.slug;
  if (slug === 'basketball' || slug === 'womens-basketball') return ['basketball', 'hoops', 'hardwood', 'point guard', 'shooting guard', 'wbb', 'mbb'];
  if (slug === 'football') return ['football', 'quarterback', 'touchdown', 'linebacker', 'wide receiver', 'running back'];
  if (slug === 'baseball') return ['baseball'];
  if (slug === 'softball') return ['softball'];
  return [...new Set([normalize(sport.name).replace(/^(?:men s|women s|mens|womens|coed) /, ''), normalize(slug).replace(/^(?:mens|womens|coed) /, '')])];
}
function explicitSports(text, school) {
  const results = new Set();
  const women = WOMEN.test(text), men = MEN.test(text);
  for (const sport of school.sports) {
    if (sport.gender === 'men' && women && !men) continue;
    if (sport.gender === 'women' && men && !women) continue;
    if (sport.slug === 'football' && /\b(?:flag football|sprint football|lightweight football)\b/.test(text)) continue;
    if (sportTerms(sport).some(term => term && phrase(term).test(text))) results.add(sport.slug);
  }
  return results;
}

export function classifyWebNews(item, school, sport, definition) {
  ({ school, sport } = canonical(school, sport));
  if (definition.school && definition.school !== school.slug) return false;
  if (definition.sport && definition.sport !== sport.slug) return false;
  const title = normalize(item.title), details = normalize(item.description), text = `${title} ${details}`;
  if (!title || BETTING.test(text) || (PROFESSIONAL.test(title) && !/\brecruit(?:ing|s|ed)?\b/.test(title))) return false;
  if (/\b(?:high school|prep|youth|little league)\b/.test(title) && !/\b(?:recruit|recruiting|commit|commits|commitment|offer|offers|signs)\b/.test(text)) return false;
  // A location or athlete surname in a summary is not program identity. For
  // description-only matches require the full institution or verified team
  // name with its mascot; clear school mentions in headlines remain eligible.
  const titleSchools = schoolsMentioned(title), detailSchools = schoolsMentioned(details, true);
  const directlyMentioned = titleSchools.has(school.slug) || detailSchools.has(school.slug);
  // A school feed does not turn a story explicitly about another team into a
  // target-school story. Matchups must also identify the requested program.
  if (!directlyMentioned && (!definition.school || titleSchools.size)) return false;
  if (!definition.sport) {
    const candidates = explicitSports(title, school);
    const relevant = candidates.size ? candidates : explicitSports(text, school);
    if (!relevant.has(sport.slug)) return false;
    // For unscoped feeds, an unqualified gender-shared sport is ambiguous.
    if (relevant.size !== 1) return false;
  } else {
    if (definition.requiresGender && sport.gender === 'men' && !MEN.test(text)) return false;
    if (definition.requiresGender && sport.gender === 'women' && !WOMEN.test(text)) return false;
    if (sport.gender === 'men' && WOMEN.test(text) && !MEN.test(title)) return false;
    if (sport.gender === 'women' && MEN.test(text) && !WOMEN.test(title)) return false;
    const titleSports = explicitSports(title, allPrograms);
    if (titleSports.size && !titleSports.has(sport.slug)) return false;
  }
  return true;
}

function plain(value, maximum) {
  if (typeof value !== 'string' || value.length > 200_000) throw new Error('Feed field exceeds budget');
  const $ = load(value); $('script,style,noscript,iframe').remove();
  return cleanText($.root().text(), maximum);
}
function publicationDate(raw) {
  const value = raw.trim();
  if (!/(?:Z|[+-]\d\d:?\d\d|\b(?:GMT|UTC|EST|EDT|CST|CDT|MST|MDT|PST|PDT))$/i.test(value)) return { publishedAt: null, publishedAtPrecision: 'unknown' };
  const time = Date.parse(value);
  return Number.isFinite(time) ? { publishedAt: new Date(time).toISOString(), publishedAtPrecision: 'instant' } : { publishedAt: null, publishedAtPrecision: 'unknown' };
}
function imageFromItem($, item, definition, fragments) {
  const candidates = [];
  for (const node of item.children().toArray()) {
    const element = $(node);
    if (['media:thumbnail', 'media:content'].includes(node.tagName) && (!element.attr('medium') || element.attr('medium') === 'image')) candidates.push({ url: element.attr('url'), alt: element.attr('caption') });
    else if (node.tagName === 'enclosure' && (!element.attr('type') || element.attr('type').startsWith('image/'))) candidates.push({ url: element.attr('url') || element.text().trim() });
  }
  for (const html of fragments) {
    if (html.length > 200_000) throw new Error('Feed HTML exceeds budget');
    const fragment = load(html);
    for (const node of fragment('img').toArray().slice(0, 3)) candidates.push({ url: fragment(node).attr('src'), alt: fragment(node).attr('alt') });
  }
  for (const candidate of candidates) {
    const url = safeUrl(candidate.url);
    if (url && definition.imageHosts.includes(new URL(url).hostname)) return { imageUrl: url, imageAlt: candidate.alt ? plain(candidate.alt, 300) || null : null };
  }
  return { imageUrl: null, imageAlt: null };
}

export function newsFeedDefinitions() { return structuredClone(registry.feeds); }
function definitionsFor(school, sport) {
  canonical(school, sport);
  return registry.feeds.filter(feed => feed.status === 'verified' && (!feed.school || feed.school === school.slug) && (!feed.sport || feed.sport === sport.slug));
}
export function webNewsSources(school, sport, observedAt = new Date().toISOString()) {
  return definitionsFor(school, sport).map(definition => ({
    url: definition.url, allowedHosts: [new URL(definition.url).hostname],
    collect: async get => parseWebNews(await get(definition.url), definition, school, sport, observedAt),
  }));
}

// A national feed is shared by hundreds of programs. Parse its metadata once,
// while retaining independent school/sport checks for every output record.
const documentCache = new Map();
let cachedCharacters = 0;
function readFeed(text, definition) {
  const cached = documentCache.get(definition.id);
  if (cached?.text === text) return cached.entries;
  if (typeof text !== 'string' || !text.trim() || text.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Invalid feed document');
  const $ = load(text, { xmlMode: true }), roots = $.root().children();
  const rss = roots.length === 1 && roots.first().is('rss') && roots.attr('version') === '2.0';
  const atom = roots.length === 1 && roots.first().is('feed') && roots.attr('xmlns') === 'http://www.w3.org/2005/Atom';
  if (!rss && !atom) throw new Error('Unrecognized publisher feed');
  const container = rss ? roots.children('channel') : roots;
  if (container.length !== 1 || container.children('title').length !== 1 || plain(container.children('title').text(), 300) !== plain(definition.feedTitle, 300)) throw new Error('Publisher feed identity mismatch');
  const items = container.children(rss ? 'item' : 'entry');
  if (items.length > 200) throw new Error('Feed record budget exceeded');
  const entries = [];
  for (const element of items.toArray()) {
    const item = $(element), titles = item.children('title');
    const links = rss ? item.children('link') : item.children('link').filter((_, node) => !$(node).attr('rel') || $(node).attr('rel') === 'alternate');
    if (titles.length !== 1 || links.length !== 1) throw new Error('Ambiguous publisher headline or link');
    const title = plain(titles.text(), 300), url = safeUrl(rss ? links.text().trim() : links.attr('href'));
    if (!title || !url || !definition.articleHosts.includes(new URL(url).hostname) || (definition.articlePathPrefix && !new URL(url).pathname.startsWith(definition.articlePathPrefix))) continue;
    const descriptions = item.children().filter((_, node) => ['description', 'summary'].includes(node.tagName));
    const categories = item.children('category').map((_, node) => $(node).attr('term') || $(node).text()).get().join(' ');
    const description = `${plain(descriptions.first().text(), 2000)} ${plain(categories, 500)}`;
    const date = publicationDate(item.children(rss ? 'pubDate' : 'published').first().text());
    const fragments = item.children().filter((_, node) => ['description', 'summary', 'content', 'content:encoded'].includes(node.tagName)).map((_, node) => $(node).text()).get();
    const creator=item.children('dc\\:creator').first();
    const authorNode=item.children('author').first();
    const author=cleanAuthor(creator.length?creator.text():authorNode.children('name').first().text()||authorNode.text());
    entries.push({ title, description, url, ...date, ...imageFromItem($, item, definition, fragments),author });
  }
  cachedCharacters -= cached?.text.length ?? 0;
  documentCache.delete(definition.id);
  if (cachedCharacters + text.length > 8_000_000 || documentCache.size >= 128) { documentCache.clear(); cachedCharacters = 0; }
  documentCache.set(definition.id, { text, entries }); cachedCharacters += text.length;
  return entries;
}

export function parseWebNews(text, requested, school, sport, observedAt) {
  const definition = definitionsFor(school, sport).find(value => value.id === requested?.id && value.url === requested?.url);
  if (!definition) throw new Error('News feed scope mismatch');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid news observation time');
  const records = new Map();
  for (const entry of readFeed(text, definition)) {
    if (!classifyWebNews(entry, school, sport, definition)) continue;
    if (entry.publishedAt && Date.parse(entry.publishedAt) > Date.parse(observedAt) + 86_400_000) continue;
    const { description, ...metadata } = entry;
    records.set(entry.url, { id: stableId(school.slug, sport.slug, entry.url), ...metadata, publisher: definition.publisher, discoverySourceUrl: definition.url });
  }
  return { records: [...records.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '')), emptyConfirmed: true, reason: 'publisher-feed-filtered-school-and-sport' };
}
