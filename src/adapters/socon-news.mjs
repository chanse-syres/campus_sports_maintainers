import { load } from 'cheerio';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';
import { assertCatalogScope } from '../providers.mjs';

const SOURCE = 'https://soconsports.com/fb/';
const MAX_BYTES = 8_000_000, MAX_RECORDS = 100, MAX_SCALAR = 4096;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function scalar(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_SCALAR) throw new Error('SoCon field exceeds budget');
  return value;
}
function publicationDate(raw) {
  const value = scalar(raw);
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value ?? '')
    ? value.replace(/(?<!\.\d{3})Z$/, '.000Z') : null;
  const time = canonical ? Date.parse(canonical) : NaN;
  const valid = Number.isFinite(time) && new Date(time).toISOString() === canonical;
  return { publishedAt: valid ? canonical : null, publishedAtPrecision: valid ? 'instant' : 'unknown' };
}
function tags(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_RECORDS) throw new Error('SoCon tag budget exceeded');
  return value.filter(object);
}

/** Read only the public football page's declared JSON and rendered article links. */
export function parseSoconFootballNews(text, sourceUrl, school, sport) {
  const canonical = assertCatalogScope(school, sport?.slug);
  if (sourceUrl !== SOURCE || canonical.slug !== 'tennessee-technological-university'
    || String(canonical.ncaaId) !== '692' || sport?.slug !== 'football'
    || !canonical.sports.some(value => value.slug === sport.slug && value.code === sport.code)) {
    throw new Error('Unreviewed SoCon school, sport, or source');
  }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid SoCon document size');
  const $ = load(text), scripts = $('script#__NEXT_DATA__[type="application/json"]');
  if (scripts.length !== 1) throw new Error('Missing or ambiguous SoCon page data');
  let data;
  try { data = JSON.parse(scripts.text()); } catch { throw new Error('Malformed SoCon page data'); }
  const page = data?.props?.pageProps;
  if (page?.params?.sport !== 'fb' || !object(page.fallback)) throw new Error('Unverified SoCon football page');
  const collections = Object.entries(page.fallback);
  if (collections.length > MAX_RECORDS) throw new Error('SoCon collection budget exceeded');
  const articles = collections.filter(([key]) => key.includes('contentTypeUid:"article"'));
  if (articles.length !== 1 || !Array.isArray(articles[0][1])) throw new Error('Missing or ambiguous SoCon articles');
  const rows = articles[0][1];
  if (rows.length > MAX_RECORDS) throw new Error('SoCon article budget exceeded');
  const anchors = $('a[href]');
  if (anchors.length > 5000) throw new Error('SoCon link budget exceeded');
  const links = new Map();
  for (const anchor of anchors.toArray()) {
    const url = safeUrl($(anchor).attr('href'), sourceUrl);
    if (!url) continue;
    const match = /^https:\/\/soconsports\.com\/fb\/article\/([1-9]\d{0,8})\/$/.exec(url);
    if (match) links.set(Number(match[1]), url);
  }
  const records = new Map();
  for (const row of rows) {
    if (!object(row)) throw new Error('Invalid SoCon article shape');
    if (row._content_type_uid !== 'article' || row._status !== 'published' || row._in_progress !== false) continue;
    if (!tags(row.sport).some(tag => tag.id === 31 && tag.alias === 'fb' && tag.title === 'Football')) continue;
    if (!tags(row.school).some(tag => tag.id === 884 && tag.alias === 'TTU' && tag.title === 'Tennessee Tech')) continue;
    const url = Number.isSafeInteger(row.id) ? links.get(row.id) : null;
    const title = cleanText(scalar(row.simple_headline), 300);
    if (!url || !title) continue;
    const candidateImage = safeUrl(scalar(row.image?.url));
    const imageUrl = candidateImage && new URL(candidateImage).hostname === 'img.boostsport.ai'
      && new URL(candidateImage).pathname.startsWith('/boost-cms/') ? candidateImage : null;
    records.set(url, { id: stableId(canonical.slug, sport.slug, url), title, url, ...publicationDate(row.publish_date),
      imageUrl, imageAlt: null, author: null, publisher: 'The Southern Conference', discoverySourceUrl: sourceUrl });
  }
  if (!records.size) throw new Error('No recognizable SoCon Tennessee Tech football records');
  return { records: [...records.values()], emptyConfirmed: false };
}
