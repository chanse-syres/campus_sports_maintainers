import { load } from 'cheerio';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';
import { assertCatalogScope } from '../providers.mjs';

const SOURCE = 'https://necsports.com/archives.aspx?path=football';
const SCHOOLS = 'https://necsports.com/services/archives.ashx/setup_schools_dropdown';
const STORIES = 'https://necsports.com/services/archives.ashx/stories?index=1&page_size=30&sport=football&season=0&school=0&search=';
const MAX_BYTES = 8_000_000;
const SCHOOL_NAME = /\b(?:CCSU|Central\s+Connecticut(?:\s+State(?:\s+University)?)?)\b/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value, max = 4096) {
  if (typeof value !== 'string') return '';
  if (value.length > max) throw new Error('NEC field exceeds budget');
  return value;
}
function document(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid NEC document size');
  return text;
}
function payload(text, max) {
  let value;
  try { value = JSON.parse(document(text)); } catch { throw new Error('Malformed NEC service response'); }
  if (!object(value) || value.error || !Array.isArray(value.data) || value.data.length > max) throw new Error('Invalid NEC service response shape or budget');
  if (value.data.some(row => !object(row))) throw new Error('Invalid NEC service record');
  return value.data;
}
function plain(value, max) {
  const $ = load(field(value, max));
  $('script,style,noscript,iframe').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}
function publicationDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/.exec(field(value));
  const day = match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
  const time = day ? Date.parse(`${day}T00:00:00.000Z`) : NaN;
  const valid = Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
  return { publishedAt: valid ? new Date(time).toISOString() : null, publishedAtPrecision: valid ? 'day' : 'unknown' };
}

/** Follow only the archive's declared public services; no script is evaluated. */
export async function collectNecFootballNews(text, sourceUrl, school, sport, fetch) {
  const canonical = assertCatalogScope(school, sport?.slug);
  if (sourceUrl !== SOURCE || canonical.slug !== 'central-connecticut-state-university'
    || String(canonical.ncaaId) !== '127' || sport?.slug !== 'football'
    || !canonical.sports.some(value => value.slug === sport.slug && value.code === sport.code)) {
    throw new Error('Unreviewed NEC school, sport, or source');
  }
  const $ = load(document(text)), scripts = $('script:not([src])');
  if (scripts.length > 200) throw new Error('NEC script budget exceeded');
  const declarations = scripts.toArray().map(element => $(element).text()).filter(script =>
    /\$\.get\(\s*["']\/services\/archives\.ashx\/stories["']/.test(script)
    && /\$\.get\(\s*["']\/services\/archives\.ashx\/setup_schools_dropdown["']/.test(script)
    && /\bschool\s*:\s*this\.school\b/.test(script) && /\bsport\s*:\s*this\.sport\b/.test(script));
  if (declarations.length !== 1) throw new Error('Missing or ambiguous NEC archive services');
  // This declared metadata is a flat JSON object, not executable JavaScript.
  const matches = [...declarations[0].matchAll(/\bvar\s+sport_obj\s*=\s*(\{[^{}]*\})\s*;/g)];
  if (matches.length !== 1) throw new Error('Missing or ambiguous NEC sport identity');
  let identity;
  try { identity = JSON.parse(matches[0][1]); } catch { throw new Error('Malformed NEC sport identity'); }
  if (identity.id !== 244 || identity.title !== 'Football' || identity.shortname !== 'football') throw new Error('Unverified NEC football archive');
  const members = payload(await fetch(SCHOOLS), 100);
  const matching = members.filter(member => member.id === 146);
  if (matching.length !== 1 || matching[0].ncaa_id !== 127 || matching[0].title !== canonical.name
    || matching[0].abbreviation !== 'CCSU' || matching[0].school_active !== true) throw new Error('Unverified NEC Central Connecticut member');
  const rows = payload(await fetch(STORIES), 30), records = new Map(), confirmed = new Map();
  for (const row of rows) {
    // The school filter omits current conference roundups. Read the declared
    // football archive and require direct school identification on every item.
    if (field(row.sports_cats).trim() !== 'Football') continue;
    const title = cleanText(plain(row.story_headline, 4096), 300);
    const summary = plain(row.story_summary, 20_000);
    const namedInTitle = SCHOOL_NAME.test(title);
    if (!title || (!namedInTitle && !SCHOOL_NAME.test(summary))) continue;
    const url = safeUrl(field(row.story_path), sourceUrl);
    if (!url || !/^https:\/\/necsports\.com\/news\/20\d{2}\/\d{1,2}\/\d{1,2}\/[^/?#]+\.aspx$/.test(url)) continue;
    // Some archive teasers retain obsolete text from an earlier season. Only
    // a direct headline or the current article body establishes school scope.
    if (!namedInTitle) {
      if (!confirmed.has(url)) {
        if (confirmed.size >= 10) continue;
        confirmed.set(url, false);
        try {
          const article = load(document(await fetch(url))), body = article('.sidearm-story-template-text');
          if (body.length === 1) {
            body.find('script,style,noscript,iframe').remove();
            confirmed.set(url, SCHOOL_NAME.test(body.text().replace(/\s+/g, ' ').trim()));
          }
        } catch { /* Unknown article scope must not become a school record. */ }
      }
      if (!confirmed.get(url)) continue;
    }
    const candidateImage = safeUrl(field(row.story_image), sourceUrl);
    const imageUrl = candidateImage && new URL(candidateImage).hostname === 'necsports.com'
      && new URL(candidateImage).pathname.startsWith('/images/') ? candidateImage : null;
    records.set(url, { id: stableId(canonical.slug, sport.slug, url), title, url, ...publicationDate(row.story_postdate),
      imageUrl, imageAlt: null, author: null, publisher: 'Northeast Conference', discoverySourceUrl: sourceUrl });
  }
  if (!records.size) throw new Error('No recognizable NEC Central Connecticut football records');
  return { records: [...records.values()], emptyConfirmed: false };
}
