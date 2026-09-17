import { load } from 'cheerio';
import { requireProvider } from '../providers.mjs';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';

const MAX_RECORDS = 1000;
const MAX_PAGES = 16;
const MAX_DOCUMENT = 2_000_000;
const MAX_TOTAL_BYTES = 16_000_000;
const VIEW_PATH = '~/Views/SkyNet/RecruitInterest/_SimpleDetailedSetForSeason.ascx';
const POSITIONS = Object.freeze({
  'Quarterback': 'QB', 'Running Back': 'RB', 'Wide Receiver': 'WR', 'Tight End': 'TE',
  'Offensive Tackle': 'OT', 'Interior Offensive Lineman': 'IOL', 'Edge': 'Edge',
  'Defensive Lineman': 'DL', 'Linebacker': 'LB', 'Cornerback': 'CB', 'Safety': 'S',
  'Athlete': 'ATH', 'Kicker': 'K', 'Punter': 'P', 'Long Snapper': 'LS',
  'Point Guard': 'PG', 'Shooting Guard': 'SG', 'Combo Guard': 'CG',
  'Small Forward': 'SF', 'Power Forward': 'PF', 'Center': 'C',
});
const BASKETBALL_POSITIONS = new Set(['Point Guard', 'Shooting Guard', 'Combo Guard', 'Small Forward', 'Power Forward', 'Center']);
const SPORT_LABELS = Object.freeze({ football: 'Football', basketball: 'Basketball', 'womens-basketball': "Women's Basketball" });

export function recruitingSourceUrl(school, sport, year, kind = 'commits') {
  const provider = requireProvider(school, sport, '247sports', school.recruitingSlug || school.recruitingName ? school : null);
  if (!Object.hasOwn(SPORT_LABELS, sport)
      || !Number.isSafeInteger(year) || year < 2000 || year > 2100
      || !['commits', 'offers'].includes(kind)) throw new Error('Unsupported recruiting scope');
  const providerSlug = provider.recruitingSlug;
  return `https://247sports.com/college/${providerSlug}/season/${year}-${sport}/${kind}/`;
}

function exactSource(raw, expected) {
  const safe = safeUrl(raw);
  if (!safe) return false;
  const value = new URL(safe);
  return value.hostname === '247sports.com' && !value.search && !value.hash && value.href.toLowerCase() === expected;
}

function document(text) {
  if (typeof text !== 'string' || text.length > MAX_DOCUMENT) throw new Error('Invalid recruiting response size');
  if (/Sorry, you have been blocked|Attention Required!|Just a moment\.\.\./i.test(text)) throw new Error('Recruiting source access challenge');
  return load(text);
}

function ratingMode($) {
  const selected = $('a.yr_plldwn').filter((_, element) => /^(247Sports|Composite)$/.test($(element).text().trim()));
  if (selected.length > 1 || (selected.length && selected.text().trim() !== '247Sports')) throw new Error('Unsupported recruiting rating system');
  return selected.length === 1 ? '247sports' : null;
}

function optionalNumber(raw, maximum, integer = false) {
  const value = cleanText(raw, 40);
  if (!value || /^(?:NA|N\/A|NR|--?|Unranked)$/i.test(value)) return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid displayed recruiting rating or rank');
  const number = Number(value);
  if (number <= 0 || number > maximum || (integer && !Number.isInteger(number))) throw new Error('Displayed recruiting rating or rank exceeds bounds');
  return number;
}

function parseRating(row, mode, expected) {
  const empty = { rating: null, ratingSystem: null, stars: null, nationalRank: null, positionRank: null, stateRank: null, rankingState: null, rankingGroup: null };
  const panel = row.find('.rating');
  if (!panel.length) return empty;
  if (panel.length !== 1 || mode !== '247sports') throw new Error('Recruiting rating system is not verified');
  const score = panel.find('.ri-page__star-and-score .score');
  if (score.length > 1) throw new Error('Ambiguous recruiting rating');
  const rating = optionalNumber(score.text(), 100);
  const stars = panel.find('.ri-page__star-and-score .icon-starsolid.yellow').length;
  if (stars > 5) throw new Error('Invalid recruiting stars');
  const result = { ...empty, rating, ratingSystem: '247sports', stars: stars || null };
  const groups = new Set();
  for (const [selector, key] of [['.natrank', 'nationalRank'], ['.posrank', 'positionRank'], ['.sttrank', 'stateRank']]) {
    const link = panel.find(selector);
    if (link.length > 1) throw new Error('Ambiguous recruiting rank');
    if (!link.length) continue;
    result[key] = optionalNumber(link.text(), 100000, true);
    const href = safeUrl(link.attr('href'), expected);
    const scope = new URL(expected.replace(/(?:commits|offers)\/$/, 'recruitrankings/'));
    const target = href && new URL(href);
    if (!target || target.hostname !== scope.hostname || target.pathname.toLowerCase() !== scope.pathname || target.hash) throw new Error('Recruiting rank scope mismatch');
    const group = target.searchParams.get('InstitutionGroup');
    if (group && /^[A-Za-z]{1,40}$/.test(group)) groups.add(group);
    if (key === 'stateRank') {
      const state = target.searchParams.get('State');
      if (state && /^[A-Z]{2}$/.test(state)) result.rankingState = state;
    }
  }
  if (groups.size > 1) throw new Error('Conflicting recruiting ranking groups');
  result.rankingGroup = [...groups][0] ?? null;
  return result;
}

function parseRow($, element, context, status, expectedPosition = null) {
  const { school, sport, year, observedAt, expected, mode } = context;
  const row = $(element);
  const link = row.find('a.ri-page__name-link');
  const profile = safeUrl(link.attr('href'), expected);
  const identity = profile && new URL(profile).hostname === '247sports.com'
    ? new URL(profile).pathname.match(/^\/player\/[a-z0-9-]+-(\d+)\/?$/i)?.[1] : null;
  const name = cleanText(link.text(), 160);
  const position = cleanText(row.find('.position').text(), 30);
  if (link.length !== 1 || !identity || !name || !position) throw new Error('Incomplete recruiting identity');
  if (expectedPosition && position.toLowerCase() !== expectedPosition.toLowerCase()) throw new Error('Recruiting position section mismatch');
  const destination = cleanText(row.find('.status img').first().attr('alt'), 160);
  // An offer list includes prospects committed elsewhere; it does not claim they committed here.
  if (status !== 'offered' && destination && destination !== school.recruitingName) throw new Error('Recruiting commitment destination mismatch');
  for (const anchor of row.find('a[href]').toArray()) {
    const href = $(anchor).attr('href');
    const rowClass = href?.match(/\/season\/(\d{4})-(football|basketball|womens-basketball)\//i);
    if (rowClass && (Number(rowClass[1]) !== year || rowClass[2].toLowerCase() !== sport)) throw new Error('Recruiting row class or sport mismatch');
  }
  const meta = row.find('.recruit .meta').first().clone();
  meta.find('a, script, style, noscript').remove();
  const location = cleanText(meta.text(), 300).match(/^(.*?)\s+\(([^()]*)\)$/);
  const image = row.find('.circle-image-block > img').first();
  const imageCandidate = safeUrl(image.attr('data-src') || image.attr('src'), expected);
  const imageUrl = imageCandidate && new URL(imageCandidate).hostname === 's3media.247sports.com'
    && /\/Uploads\/Assets\//i.test(new URL(imageCandidate).pathname) ? imageCandidate : null;
  return {
    id: stableId(school.slug, sport, String(year), '247sports', identity), name, classYear: year, position,
    status, schoolId: school.slug, sport, sourceUrl: expected, updatedAt: new Date(observedAt).toISOString(),
    profileUrl: profile, imageUrl, schoolName: location ? cleanText(location[1], 160) || null : null,
    hometown: location ? cleanText(location[2], 160) || null : null,
    ...parseRating(row, mode, expected),
  };
}

function addRecord(records, record) {
  if (records.has(record.id)) throw new Error('Duplicate recruiting provider identity');
  if (records.size >= MAX_RECORDS) throw new Error('Recruiting record count exceeds budget');
  records.set(record.id, record);
}

function pageContext(text, sourceUrl, school, sport, year, observedAt, kind) {
  school = { ...school, ...requireProvider(school, sport, '247sports', school.recruitingSlug || school.recruitingName ? school : null) };
  const expected = recruitingSourceUrl(school, sport, year, kind);
  if (!exactSource(sourceUrl, expected)) throw new Error('Recruiting source scope mismatch');
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid recruiting observation time');
  const $ = document(text);
  if ($('link[rel="canonical"]').length !== 1 || !exactSource($('link[rel="canonical"]').attr('href'), expected)) throw new Error('Recruiting canonical scope mismatch');
  const heading = cleanText($('h1').first().text(), 300);
  const match = heading.match(/^(.*?) (\d{4}) (Football|Basketball|Women's Basketball) (Commits|Offers) \((\d+)\)(?: All-Time Commits)?$/);
  if (!match || match[1] !== school.recruitingName || Number(match[2]) !== year || match[3] !== SPORT_LABELS[sport] || match[4].toLowerCase() !== kind) throw new Error('Recruiting heading scope mismatch');
  const count = Number(match[5]);
  if (count > MAX_RECORDS) throw new Error('Recruiting record count exceeds budget');
  const list = $('ul.ri-page__list');
  if (list.length !== 1 || list.children('li').length > MAX_RECORDS + 2 * MAX_PAGES) throw new Error('Recruiting listing missing or exceeds budget');
  return { $, list, count, school, sport, year, observedAt, expected, mode: ratingMode($) };
}

/** Complete commitment listing. Values absent from displayed provider fields stay null. */
export function parseRecruiting(text, sourceUrl, school, sport, year, observedAt) {
  const context = pageContext(text, sourceUrl, school, sport, year, observedAt, 'commits');
  const { $, list, count } = context;
  if (list.find('a').filter((_, anchor) => /(?:load|show)\s+more/i.test($(anchor).text())).length) throw new Error('Recruiting listing is paginated; complete snapshot required');
  const records = new Map();
  let section = '', hasExplicitEmpty = false;
  for (const element of list.children('li.ri-page__list-item').toArray()) {
    const row = $(element);
    if (row.hasClass('list-header')) { section = cleanText(row.find('.name').text(), 120); continue; }
    if (row.hasClass('ri-page__list-item--no-results')) {
      hasExplicitEmpty = cleanText(row.text()) === `No Results for ${year} ${SPORT_LABELS[sport]}`;
      continue;
    }
    if (/transfers?|de-?commits?/i.test(section)) continue;
    let status;
    if (/^Hard Commits? \(\d+\)$/.test(section)) status = 'committed';
    else if (/^Signed(?: Letter of Intent)? \(\d+\)$/.test(section)) status = 'signed';
    else if (/^(?:Enrolled|Enrollees) \(\d+\)$/.test(section)) status = 'enrolled';
    else throw new Error('Unknown recruiting commitment section');
    addRecord(records, parseRow($, element, context, status));
  }
  if (records.size !== count || (count === 0 && !hasExplicitEmpty)) throw new Error('Recruiting count mismatch or unconfirmed empty result');
  return [...records.values()];
}

function continuationUrl(raw, expected) {
  const safe = safeUrl(raw, expected);
  const url = safe && new URL(safe);
  const base = new URL(expected);
  if (!url || url.origin !== base.origin || url.pathname !== base.pathname || url.hash
      || [...url.searchParams.keys()].sort().join(',') !== 'Position,ViewPath'
      || url.searchParams.get('ViewPath') !== VIEW_PATH || !/^\d{1,3}$/.test(url.searchParams.get('Position') || '')) {
    throw new Error('Recruiting continuation is outside the approved source');
  }
  // Rebuild from fixed components; never follow arbitrary provider-linked URLs.
  return `${expected}?ViewPath=${encodeURIComponent(VIEW_PATH)}&Position=${url.searchParams.get('Position')}`;
}

function equivalentContinuation(raw, expected) {
  try { return continuationUrl(raw, expected.split('?')[0]) === expected; } catch { return false; }
}

/** Fetch all advertised offer position sections, bounded and checked against every declared count. */
export async function collectRecruiting({ school, sport, year, observedAt, get, kind = 'commits' }) {
  school = { ...school, ...requireProvider(school, sport, '247sports', school.recruitingSlug || school.recruitingName ? school : null) };
  if (typeof get !== 'function') throw new Error('Recruiting fetch function is required');
  const sourceUrl = recruitingSourceUrl(school, sport, year, kind);
  const initial = await get(sourceUrl);
  if (kind === 'commits') {
    const records = parseRecruiting(initial, sourceUrl, school, sport, year, observedAt);
    // WBB provider coverage is incomplete: an explicit empty listing does not
    // establish an empty real-world class and must not erase prior records.
    return { records, season: String(year), emptyConfirmed: sport !== 'womens-basketball' || records.length > 0, sourceUrl, pagesFetched: 1, expectedCount: records.length,
      reason: sport === 'womens-basketball' ? (records.length ? 'provider-reported-records-coverage-incomplete' : 'provider-has-no-commitment-records') : null };
  }
  const context = pageContext(initial, sourceUrl, school, sport, year, observedAt, kind);
  const { $, list, count } = context;
  const sections = [];
  let current = null, hasExplicitEmpty = false;
  for (const element of list.children('li').toArray()) {
    const row = $(element);
    if (row.hasClass('list-header')) {
      const match = cleanText(row.find('.name').text(), 120).match(/^(.*?) \((\d+)\)$/);
      if (!match || !Object.hasOwn(POSITIONS, match[1]) || BASKETBALL_POSITIONS.has(match[1]) !== (sport !== 'football')
          || Number(match[2]) > MAX_RECORDS || sections.some(section => section.name === match[1])) throw new Error('Unknown or duplicate recruiting offer section');
      current = { name: match[1], count: Number(match[2]), rows: [], next: null };
      sections.push(current);
      if (sections.length > MAX_PAGES) throw new Error('Recruiting section count exceeds budget');
    } else if (row.hasClass('ri-page__list-item--no-results')) {
      hasExplicitEmpty = cleanText(row.text()) === `No Results for ${year} ${SPORT_LABELS[sport]}`;
    } else if (row.hasClass('showmore_blk')) {
      const next = row.find('a[data-js="showmore"]');
      if (!current || current.next || next.length !== 1) throw new Error('Ambiguous recruiting continuation');
      current.next = continuationUrl(next.attr('href'), sourceUrl);
    } else if (row.hasClass('ri-page__list-item')) {
      if (!current) throw new Error('Recruiting offer has no position section');
      current.rows.push(parseRow($, element, context, 'offered', POSITIONS[current.name]));
    } else throw new Error('Unexpected recruiting offer listing row');
  }
  if (sections.reduce((total, section) => total + section.count, 0) !== count || (!count && !hasExplicitEmpty)) throw new Error('Recruiting offer section totals do not match the declared total');
  let pagesFetched = 1, bytes = Buffer.byteLength(initial), sourceRecordCount = 0, duplicateCount = 0;
  const records = new Map(), fetched = new Set();
  for (const section of sections) {
    let rows = section.rows;
    if (section.next) {
      if (++pagesFetched > MAX_PAGES || fetched.has(section.next)) throw new Error('Recruiting continuation exceeds budget or repeats');
      fetched.add(section.next);
      const html = await get(section.next);
      bytes += Buffer.byteLength(html);
      if (bytes > MAX_TOTAL_BYTES) throw new Error('Recruiting download exceeds total budget');
      const page = document(html);
      if (page('link[rel="canonical"]').length !== 1 || !equivalentContinuation(page('link[rel="canonical"]').attr('href'), section.next)
          || cleanText(page('title').first().text(), 300) !== `${school.recruitingName} ${year} ${section.name} Offers`) throw new Error('Recruiting continuation scope mismatch');
      if (page('[data-js="showmore"]').length) throw new Error('Recruiting continuation is incomplete');
      const elements = page('#page-content > li.ri-page__list-item');
      if (elements.length !== section.count) throw new Error('Recruiting continuation count mismatch');
      rows = elements.toArray().map(element => parseRow(page, element, context, 'offered', POSITIONS[section.name]));
      // Provider currently sends entire sections. If it starts sending offsets, fail closed.
      const completeIds = new Set(rows.map(record => record.id));
      if (section.rows.some(record => !completeIds.has(record.id))) throw new Error('Recruiting continuation lost initially displayed rows');
    }
    if (rows.length !== section.count) throw new Error('Recruiting offer section is incomplete');
    for (const record of rows) {
      sourceRecordCount++;
      const prior = records.get(record.id);
      if (prior) {
        // Provider lists can repeat the exact same offer. Verify the source row
        // count separately; never describe that declared count as unique people.
        if (JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('Conflicting duplicate recruiting offer identity');
        duplicateCount++;
      } else addRecord(records, record);
    }
  }
  if (sourceRecordCount !== count || records.size !== count - duplicateCount) throw new Error('Recruiting offer count mismatch');
  return {
    records: [...records.values()], season: String(year), emptyConfirmed: sport !== 'womens-basketball' || records.size > 0, sourceUrl, pagesFetched,
    expectedCount: count, sourceRecordCount, duplicateCount,
    reason: duplicateCount ? `provider-duplicate-records-deduplicated:${duplicateCount}` : sport === 'womens-basketball'
      ? (records.size ? 'provider-reported-records-coverage-incomplete' : 'provider-has-no-offer-records') : null,
  };
}
