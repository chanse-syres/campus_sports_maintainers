import { load } from 'cheerio';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';
import { assertCatalogScope } from '../providers.mjs';

const MAX_BYTES = 8_000_000, MAX_CONFIRMATIONS = 10;
const REVIEWS = Object.freeze({
  'central-connecticut-state-university': {
    ncaaId: '127', host: 'necsports.com', memberId: 146,
    memberTitle: 'Central Connecticut State University', abbreviation: 'CCSU', publisher: 'Northeast Conference',
    schoolName: /\b(?:CCSU|Central\s+Connecticut(?:\s+State(?:\s+University)?)?)\b/i,
    sports: { football: [244, 'football', 'Football', 'MFB'], basketball: [235, 'mbball', "Men's Basketball", 'MBB'],
      'womens-basketball': [240, 'wbball', "Women's Basketball", 'WBB'], baseball: [237, 'baseball', 'Baseball', 'MBA'],
      'mens-cross-country': [238, 'mcross', "Men's Cross Country", 'MCC'], 'mens-soccer': [247, 'msoc', "Men's Soccer", 'MSO'],
      'mens-track-indoor': [245, 'mitrack', "Men's Indoor Track", 'MTI'], 'mens-track-outdoor': [246, 'mtrack', "Men's Outdoor Track", 'MTO'],
      softball: [252, 'softball', 'Softball', 'WSB'], 'womens-cross-country': [241, 'wcross', "Women's Cross Country", 'WCC'],
      'womens-lacrosse': [256, 'wlax', "Women's Lacrosse", 'WLA'], 'womens-soccer': [251, 'wsoc', "Women's Soccer", 'WSO'],
      'womens-swimming-and-diving': [253, 'swim', "Women's Swimming & Diving", 'WSW'],
      'womens-track-indoor': [249, 'witrack', "Women's Indoor Track", 'WTI'], 'womens-track-outdoor': [250, 'wtrack', "Women's Outdoor Track", 'WTO'],
      'womens-volleyball': [255, 'wvball', "Women's Volleyball", 'WVB'] },
  },
  'tennessee-technological-university': {
    ncaaId: '692', host: 'soconsports.com', memberId: 47,
    memberTitle: 'Tennessee Tech', abbreviation: 'TTU', publisher: 'The Southern Conference',
    schoolName: /\b(?:TTU|Tennessee\s+Tech(?:nological)?(?:\s+University)?)\b/i,
    sports: { football: [2, 'football', 'Football', 'MFB'], basketball: [4, 'mbball', "Men's Basketball", 'MBB'],
      'womens-basketball': [13, 'wbball', "Women's Basketball", 'WBB'], baseball: [1, 'baseball', 'Baseball', 'MBA'],
      'mens-cross-country': [5, 'mcross', "Men's Cross Country", 'MCC'], 'mens-golf': [6, 'mgolf', "Men's Golf", 'MGO'],
      'mens-tennis': [11, 'mten', "Men's Tennis", 'MTE'], softball: [38, 'sb', 'Softball', 'WSB'],
      'womens-cross-country': [14, 'wcross', "Women's Cross Country", 'WCC'], 'womens-golf': [15, 'wgolf', "Women's Golf", 'WGO'],
      'womens-soccer': [19, 'wsoc', "Women's Soccer", 'WSO'], 'womens-track-indoor': [16, 'witrack', "Women's Indoor Track and Field", 'WTI'],
      'womens-track-outdoor': [21, 'wtrack', "Women's Outdoor Track and Field", 'WTO'], 'womens-volleyball': [46, 'vb', 'Volleyball', 'WVB'] },
  },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value, max = 4096) {
  if (typeof value !== 'string') return '';
  if (value.length > max) throw new Error('Conference field exceeds budget');
  return value;
}
function document(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid conference document size');
  return text;
}
function payload(text, max) {
  let value;
  try { value = JSON.parse(document(text)); } catch { throw new Error('Malformed conference service response'); }
  if (!object(value) || value.error || !Array.isArray(value.data) || value.data.length > max) throw new Error('Invalid conference service response shape or budget');
  if (value.data.some(row => !object(row))) throw new Error('Invalid conference service record');
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
function categoriesFit(value, expected, title) {
  const categories = field(value).split(',').map(part => part.trim()).filter(Boolean);
  if (!categories.includes(expected)) return false;
  if (categories.every(category => category === expected || category === 'General')) return true;
  // A joint basketball schedule or media day explicitly covers both programs.
  // Broad academic/all-sport stories must not fill a program's news collection.
  return ["Men's Basketball", "Women's Basketball"].includes(expected)
    && categories.every(category => ['General', "Men's Basketball", "Women's Basketball"].includes(category))
    && /basketball/i.test(title) && /(?:schedule|media day)/i.test(title);
}

/** Read only services declared by these reviewed public conference archives. */
export async function collectSidearmConferenceNews(text, sourceUrl, school, sport, fetch) {
  const canonical = assertCatalogScope(school, sport?.slug);
  const review = REVIEWS[canonical.slug], identity = review?.sports[sport?.slug];
  const canonicalSport = canonical.sports.find(value => value.slug === sport.slug);
  if (!identity || String(canonical.ncaaId) !== review.ncaaId || sport.code !== identity[3]
    || canonicalSport.code !== identity[3] || sport.gender !== canonicalSport.gender
    || sourceUrl !== `https://${review.host}/archives.aspx?path=${identity[1]}`) {
    throw new Error('Unreviewed conference school, sport, or source');
  }
  const $ = load(document(text)), scripts = $('script:not([src])');
  if (scripts.length > 200) throw new Error('Conference script budget exceeded');
  const declarations = scripts.toArray().map(element => $(element).text()).filter(script =>
    /\$\.get\(\s*["']\/services\/archives\.ashx\/stories["']/.test(script)
    && /\$\.get\(\s*["']\/services\/archives\.ashx\/setup_schools_dropdown["']/.test(script)
    && /\bschool\s*:\s*this\.school\b/.test(script) && /\bsport\s*:\s*this\.sport\b/.test(script));
  if (declarations.length !== 1) throw new Error('Missing or ambiguous conference archive services');
  const matches = [...declarations[0].matchAll(/\bvar\s+sport_obj\s*=\s*(\{[^{}]*\})\s*;/g)];
  if (matches.length !== 1) throw new Error('Missing or ambiguous conference sport identity');
  let declared;
  try { declared = JSON.parse(matches[0][1]); } catch { throw new Error('Malformed conference sport identity'); }
  if (declared.id !== identity[0] || declared.title !== identity[2] || declared.shortname !== identity[1]) throw new Error('Unverified conference sport archive');
  const membersUrl = `https://${review.host}/services/archives.ashx/setup_schools_dropdown`;
  const members = payload(await fetch(membersUrl), 100);
  const matching = members.filter(member => member.id === review.memberId);
  if (matching.length !== 1 || String(matching[0].ncaa_id) !== review.ncaaId || matching[0].title !== review.memberTitle
    || matching[0].abbreviation !== review.abbreviation || matching[0].school_active !== true) throw new Error('Unverified conference school member');
  const rows = new Map();
  // Current sport pages include new stories whose school tag is missing. The
  // school filter supplies deeper program coverage; neither alone is complete.
  for (const memberId of [0, review.memberId]) {
    const storiesUrl = `https://${review.host}/services/archives.ashx/stories?index=1&page_size=30&sport=${identity[1]}&season=0&school=${memberId}&search=`;
    for (const row of payload(await fetch(storiesUrl), 30)) {
      const url = safeUrl(field(row.story_path), sourceUrl);
      if (!url || new URL(url).hostname !== review.host || !/^\/news\/20\d{2}\/\d{1,2}\/\d{1,2}\/[^/?#]+\.aspx$/.test(new URL(url).pathname)
        || new URL(url).search || new URL(url).hash) continue;
      const existing = rows.get(url);
      if (existing) existing.filtered ||= memberId !== 0;
      else rows.set(url, { row, filtered: memberId !== 0 });
    }
  }
  const records = new Map(), confirmed = new Map();
  const candidates = [...rows.entries()].sort(([, a], [, b]) =>
    String(publicationDate(b.row.story_postdate).publishedAt ?? '').localeCompare(String(publicationDate(a.row.story_postdate).publishedAt ?? '')));
  for (const [url, { row, filtered }] of candidates) {
    const title = cleanText(plain(row.story_headline, 4096), 300);
    if (!title || !categoriesFit(row.sports_cats, identity[2], title)) continue;
    const namedInTitle = review.schoolName.test(title);
    const summary = plain(row.story_summary, 20_000);
    if (!namedInTitle && !filtered && !review.schoolName.test(summary)) continue;
    if (!namedInTitle) {
      if (!confirmed.has(url)) {
        if (confirmed.size >= MAX_CONFIRMATIONS) continue;
        confirmed.set(url, false);
        try {
          const article = load(document(await fetch(url)));
          let body = article('.sidearm-story-template-text');
          // SoCon's migrated archive uses the older article-wrapper template.
          // Scope only its story content, excluding the header and site menus.
          if (body.length === 0 && article('main article.article-wrapper.news').length === 1) {
            body = article('main article.article-wrapper.news > .article-content');
          }
          if (body.length === 1) {
            body.find('script,style,noscript,iframe,header').remove();
            confirmed.set(url, review.schoolName.test(body.text().replace(/\s+/g, ' ').trim()));
          }
        } catch { /* An absent or denied body cannot establish school scope. */ }
      }
      if (!confirmed.get(url)) continue;
    }
    const candidateImage = safeUrl(field(row.story_image), sourceUrl);
    const imageUrl = candidateImage && new URL(candidateImage).hostname === review.host
      && new URL(candidateImage).pathname.startsWith('/images/') ? candidateImage : null;
    records.set(url, { id: stableId(canonical.slug, sport.slug, url), title, url, ...publicationDate(row.story_postdate),
      imageUrl, imageAlt: null, author: null, publisher: review.publisher, discoverySourceUrl: sourceUrl });
  }
  if (!records.size) throw new Error('No recognizable conference school and sport records');
  return { records: [...records.values()], emptyConfirmed: false };
}

export const collectNecNews = collectSidearmConferenceNews;
export const collectNecFootballNews = collectNecNews;
