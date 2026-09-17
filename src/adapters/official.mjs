import { load } from 'cheerio';
import { cleanText, safeUrl, stableId } from '../normalize.mjs';
import { matchSport, matchSportRoute, sportGender, normalizeSportLabel } from '../sports.mjs';

const MAX_BYTES = 8_000_000, MAX_RECORDS = 1000, MAX_SCALAR = 4096;
const host = url => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
const own = (object, key) => object != null && typeof object === 'object' && Object.hasOwn(object, key);
const recordObject = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => {
  if (typeof value === 'string' && value.length > MAX_SCALAR) throw new Error('Official scalar exceeds budget');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
};
const tidy = (value, max = 300) => cleanText(scalar(value), max) || null;

function document(text, sourceUrl, school) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid official document size');
  const url = safeUrl(sourceUrl), base = safeUrl(school?.athleticsUrl);
  if (!url || !base) throw new Error('Invalid official source URL');
  const hosts = new Set([host(base), ...(school.allowedHosts ?? []).filter(value => typeof value === 'string').map(value => value.replace(/^www\./, '').toLowerCase())]);
  if (!hosts.has(host(url))) throw new Error('Official source is outside school scope');
  const scopedUrl = value => { const result = safeUrl(scalar(value), sourceUrl); return result && hosts.has(host(result)) ? result : null; };
  return { $: load(text), scopedUrl };
}

// Dereference only known scalar fields and explicit one-level relationships.
// Never evaluate scripts, revive graph types, or recursively copy arbitrary keys.
function nuxt($) {
  const scripts = $('script#__NUXT_DATA__[type="application/json"]');
  if (!scripts.length) return null;
  if (scripts.length !== 1) throw new Error('Ambiguous official archive data');
  let table;
  try { table = JSON.parse(scripts.text()); } catch { throw new Error('Malformed official archive data'); }
  if (!Array.isArray(table) || table.length > 150_000) throw new Error('Official archive shape exceeds budget');
  const ref = index => Number.isSafeInteger(index) && index >= 0 && index < table.length ? table[index] : undefined;
  const field = (node, key) => own(node, key) ? scalar(ref(node[key])) : null;
  const object = (node, key) => { const value = own(node, key) ? ref(node[key]) : null; return recordObject(value) ? value : null; };
  const list = (node, key) => {
    const value = own(node, key) ? ref(node[key]) : null;
    if (!Array.isArray(value)) return null;
    if (value.length > MAX_RECORDS) throw new Error('Official record budget exceeded');
    return value.map(ref).filter(recordObject);
  };
  return { nodes: table.filter(recordObject), ref, field, object, list };
}

function labelsFor(graph, node) {
  if (!node) return [];
  return ['title', 'name', 'slug', 'shortname', 'shortName', 'abbreviation', 'abbrev', 'global_sport_name_slug', 'globalSportNameSlug']
    .map(key => graph.field(node, key)).filter(Boolean);
}
const labelsMatch = (labels, sport) => labels.some(label => matchSport(label, sport) || String(label).split(/[,;]/).some(part => matchSport(part.trim(), sport)));
function structuredSportMatches(graph, node, sport) {
  return labelsMatch(labelsFor(graph, node), sport);
}
function ensureBudget(count) { if (count > MAX_RECORDS) throw new Error('Official record budget exceeded'); }

function dayValue(value) {
  const day = value?.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/)?.[1];
  if (!day) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? new Date(ms).toISOString() : null;
}
function dateValue(value) {
  value = scalar(value);
  if (!value) return { publishedAt: null, publishedAtPrecision: 'unknown' };
  if (/(?:Z|[+-]\d\d:?\d\d|GMT|UTC)$/i.test(value.trim())) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { publishedAt: new Date(ms).toISOString(), publishedAtPrecision: 'instant' };
  }
  const usDay = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: |$)/);
  const date = dayValue(usDay ? `${usDay[3]}-${usDay[1].padStart(2, '0')}-${usDay[2].padStart(2, '0')}` : value);
  return { publishedAt: date, publishedAtPrecision: date ? 'day' : 'unknown' };
}

// Read a JSON object literal only; script code is never evaluated. This covers
// the data embedded by older Sidearm templates without importing their scripts.
function jsonAssignment(script, name) {
  const match = new RegExp(`(?:^|[;\\s])(?:var\\s+)?${name}\\s*=\\s*(\\{)`).exec(script);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function labelConflicts(labels, sport) {
  const expected = sportGender(sport);
  const genders = labels.flatMap(label => normalizeSportLabel(label).match(/\b(?:mens|womens)\b/g) ?? []);
  if (expected && genders.length && !genders.includes(expected)) return true;
  const normalized = labels.map(normalizeSportLabel);
  if (sport.slug === 'mens-crew' && normalized.some(label => /\blightweight\b/.test(label))) return true;
  if (sport.slug === 'mens-lightweight-crew' && normalized.some(label => /\bheavyweight\b/.test(label))) return true;
  return false;
}

export async function collectOfficialNews(text, sourceUrl, school, sport, get, followedArchive = false) {
  try { return parseOfficialNews(text, sourceUrl, school, sport); }
  catch (error) {
    // Follow only the public JSON service declared in a verified sport archive.
    const { $, scopedUrl } = document(text, sourceUrl, school);
    if (!matchSportRoute(sourceUrl, sport)) throw error;
    if (!followedArchive && !/\/(?:archives|news)\/?$/.test(new URL(sourceUrl).pathname)) {
      const archive = $('a[href]').toArray().map(element => scopedUrl($(element).attr('href')))
        .find(url => url && /\/(?:archives|news)\/?$/.test(new URL(url).pathname) && matchSportRoute(url, sport));
      if (archive) {
        const result = await collectOfficialNews(await get(archive), archive, school, sport, get, true);
        return { ...result, records: result.records.map(record => ({ ...record, discoverySourceUrl: sourceUrl })) };
      }
    }
    for (const element of $('script').toArray().slice(0, 200)) {
      const script = $(element).text();
      if (!script.includes('"/services/archives.ashx/stories"')) continue;
      const metadata = jsonAssignment(script, 'sport_obj');
      if (!metadata || ![metadata.title, metadata.shortname].some(label => matchSport(label, sport)) || !/^[a-z][a-z0-9-]{0,79}$/.test(metadata.shortname)) throw error;
      const apiUrl = new URL('/services/archives.ashx/stories', sourceUrl);
      apiUrl.search = new URLSearchParams({ index: '1', page_size: '100', sport: metadata.shortname, season: '0', search: '' });
      const payload = JSON.parse(await get(apiUrl.href));
      if (!recordObject(payload) || payload.error || !Array.isArray(payload.data) || payload.data.length > 100) throw new Error('Official archive service shape changed');
      if (!payload.data.length) return { records: [], season: null, emptyConfirmed: true };
      // Pass only the public record data through the same strict field mapper.
      const escaped = JSON.stringify({ type: 'stories', data: payload.data }).replaceAll('<', '\\u003c');
      return parseOfficialNews(`<script>var obj = ${escaped};</script>`, sourceUrl, school, sport);
    }
    throw error;
  }
}
function finish(records, season = null, emptyConfirmed = false) {
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  ensureBudget(unique.length);
  if (!unique.length && !emptyConfirmed) throw new Error('No recognizable official records for requested sport');
  return { records: unique, season, emptyConfirmed: !unique.length && emptyConfirmed };
}
function seasonValue($, kind) {
  const title = $('h1').first().text();
  return title.toLowerCase().includes(kind) ? title.match(/\b20\d\d(?:[-–](?:20)?\d\d)?\b/)?.[0] ?? null : null;
}

export function parseOfficialNews(text, sourceUrl, school, sport) {
  const { $, scopedUrl } = document(text, sourceUrl, school), graph = nuxt($), records = [], excludedUrls = new Set();
  let candidates = 0;
  const add = ({ title, path, date, image, alt, labels = [], primaryLabels = [] }) => {
    ensureBudget(++candidates);
    const url = scopedUrl(path), plainTitle = tidy(title);
    if (!url || !plainTitle || url === sourceUrl || !/\/[a-z0-9][a-z0-9/_-]*/i.test(new URL(url).pathname)) return;
    // Cross-posted categories must not override the publisher's explicit
    // primary team (for example, a men's recap tagged for both squash teams).
    if (labelConflicts(primaryLabels, sport)) { excludedUrls.add(url); return; }
    if (labelConflicts(labels, sport)) return;
    if (!labelsMatch(labels, sport) && !matchSportRoute(url, sport)) return;
    const imageUrl = image ? safeUrl(scalar(image), sourceUrl) : null;
    records.push({ id: stableId(school.slug, sport.slug, url), title: plainTitle, url, ...dateValue(date),
      imageUrl, imageAlt: imageUrl ? tidy(alt) : null, publisher: `${cleanText(school.name, 100)} Athletics`, discoverySourceUrl: sourceUrl });
  };
  for (const element of $('script:not([src])').toArray().slice(0, 200)) {
    const object = jsonAssignment($(element).text(), 'obj');
    if (object?.type !== 'stories' || !Array.isArray(object.data)) continue;
    ensureBudget(object.data.length);
    for (const story of object.data) {
      if (!recordObject(story)) throw new Error('Invalid official story');
      add({ title: story.story_headline ?? story.title, path: story.story_path ?? story.url,
        date: story.story_postdate ?? story.date, image: story.story_image ?? story.image?.url, alt: story.image_alt_text,
        labels: [story.sport_title, story.sports_cats, story.sport?.title, story.sport?.shortname].filter(Boolean),
        primaryLabels: [story.sport_title, story.sport?.title, story.sport?.shortname].filter(Boolean) });
    }
  }
  if (graph) for (const node of graph.nodes) {
    const f = key => graph.field(node, key);
    if (own(node, 'storyHeadline') && own(node, 'storyPath')) {
      add({ title: f('storyHeadline'), path: f('storyPath'), date: f('storyPostdate'), image: f('storyImage'),
        labels: [f('sportsCats'), f('sportTitle')].filter(Boolean), primaryLabels: [f('sportTitle')].filter(Boolean) });
    } else if (own(node, 'published_at') && own(node, 'permalink')) {
      if (f('visibility') !== 'public') continue;
      const sports = graph.list(node, 'sports') ?? graph.list(node, 'orderedSports') ?? [], media = graph.object(node, 'image');
      add({ title: f('title'), path: f('permalink'), date: f('published_at'), image: graph.field(media, 'url'), alt: graph.field(media, 'alt'),
        labels: sports.flatMap(item => labelsFor(graph, item)) });
    } else if (own(node, 'sub_headline') && own(node, 'url') && own(node, 'sport')) {
      const media = graph.object(node, 'image');
      const primaryLabels = labelsFor(graph, graph.object(node, 'sport'));
      add({ title: f('title'), path: f('url'), date: f('date'), image: graph.field(media, 'url'), alt: graph.field(media, 'alt_text'),
        labels: primaryLabels, primaryLabels });
    }
  }
  // A generic RSS feed never inherits the requested sport. Each item's exact
  // category or sport route must establish scope, even for a ?path= feed.
  if (/^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed)\b/i.test(text)) {
    const xml = load(text, { xml: true }), items = xml('item, entry');
    ensureBudget(items.length);
    items.each((_, element) => {
      const item = xml(element), image = item.find('media\\:thumbnail, media\\:content, enclosure').filter((_, el) => !xml(el).attr('type') || xml(el).attr('type').startsWith('image/')).first();
      add({ title: item.children('title').text(), path: item.children('link').filter((_, el) => !xml(el).attr('rel') || xml(el).attr('rel') === 'alternate').first().attr('href') || item.children('link').first().text(),
        date: item.children('pubDate, published, updated').first().text(), image: image.attr('url'), alt: image.find('media\\:title').text(),
        labels: item.children('category').map((_, el) => xml(el).attr('term') || xml(el).text()).get() });
    });
  } else {
    const cards = $('.sidearm-news-list-item, .sidearm-story, .c-stories__item, .s-card--type-story, #article-content-blocks > .item');
    ensureBudget(cards.length);
    cards.each((_, element) => {
      const card = $(element), anchor = card.find('.sidearm-news-list-item-title a, .sidearm-story-title a, a.c-stories__title, .c-stories__title a, a.c-stories__url, a.s-stories-cards__story-title-link--template-default, .content-heading h2 a').first();
      if (!anchor.length) return;
      const image = card.find('img').first(), time = card.find('time').first();
      add({ title: anchor.text(), path: anchor.attr('href'), date: time.attr('datetime'), image: image.attr('data-src') || image.attr('src'), alt: image.attr('alt'),
        labels: card.find('.sidearm-news-list-item-sport, .c-stories__sport, .c-item-details__sport-text, [data-sport], .content-heading .category').map((_, el) => $(el).attr('title') || $(el).attr('data-sport') || $(el).text()).get() });
    });
  }
  // One page can represent a story in structured data and a visual card.
  // Sparse cards must not erase the publisher's known date or photograph.
  const merged = new Map();
  for (const record of records) {
    if (excludedUrls.has(record.url)) continue;
    const previous = merged.get(record.id);
    const precision = { unknown: 0, day: 1, instant: 2 };
    const dated = previous && precision[previous.publishedAtPrecision] > precision[record.publishedAtPrecision] ? previous : record;
    const pictured = record.imageUrl ? record : previous?.imageUrl ? previous : record;
    const imageAlt = pictured.imageAlt ?? (pictured.imageUrl === previous?.imageUrl ? previous.imageAlt : null);
    merged.set(record.id, { ...record, publishedAt: dated.publishedAt, publishedAtPrecision: dated.publishedAtPrecision,
      imageUrl: pictured.imageUrl, imageAlt });
  }
  return finish([...merged.values()]);
}

function requireSourceRoute(sourceUrl, sport, kind) {
  if (!matchSportRoute(sourceUrl, sport) || !new URL(sourceUrl).pathname.split('/').includes(kind)) throw new Error(`Official ${kind} source sport scope is unverified`);
}
function rosterGenderMatches(graph, player, sport) {
  const gender = graph.field(player, 'gender');
  if (!gender) return true;
  const expected = sportGender(sport), actual = sportGender({ gender });
  return !expected || actual === expected;
}

export function parseOfficialRoster(text, sourceUrl, school, sport) {
  const { $, scopedUrl } = document(text, sourceUrl, school);
  requireSourceRoute(sourceUrl, sport, 'roster');
  const graph = nuxt($), records = [];
  let season = seasonValue($, 'roster'), candidates = 0, emptyConfirmed = false;
  const add = ({ name, path, position, jersey, year, image, id }) => {
    ensureBudget(++candidates);
    name = tidy(name, 160);
    const url = path ? scopedUrl(path) : null;
    if (!name || (path && !url)) throw new Error('Invalid official roster player');
    records.push({ id: stableId(school.slug, sport.slug, id || url || name), name, position: tidy(position, 80), jersey: tidy(jersey, 10),
      year: tidy(year, 40), imageUrl: image ? safeUrl(scalar(image), sourceUrl) : null, url });
  };
  if (graph) for (const node of graph.nodes) {
    // Anchor players to the selected roster container; sidebar players and
    // coaches elsewhere in the graph must not leak into the returned roster.
    if (!own(node, 'players') || !own(node, 'displayTitle') || !own(node, 'sport')) continue;
    if (!structuredSportMatches(graph, graph.object(node, 'sport'), sport)) continue;
    const players = graph.list(node, 'players');
    if (!players) throw new Error('Official roster players shape changed');
    season = graph.field(graph.object(node, 'season'), 'title') || season;
    if (!players.length) emptyConfirmed = true;
    for (const player of players) {
      if (graph.ref(player.hide) === true || !rosterGenderMatches(graph, player, sport)) continue;
      const playerSport = graph.object(player, 'sport');
      if (playerSport && !structuredSportMatches(graph, playerSport, sport)) continue;
      const media = graph.object(player, 'image');
      add({ name: [graph.field(player, 'firstName'), graph.field(player, 'lastName')].filter(Boolean).join(' '), id: graph.field(player, 'rosterPlayerId'),
        path: graph.field(player, 'call_to_action'), position: graph.field(player, 'positionShort') || graph.field(player, 'positionLong'),
        jersey: graph.field(player, 'jerseyNumber'), year: graph.field(player, 'academicYearLong') || graph.field(player, 'academicYearShort'),
        image: graph.field(media, 'absoluteUrl') || graph.field(media, 'url') });
    }
  }
  if (!records.length && !emptyConfirmed) {
    const players = $('.sidearm-roster-player');
    ensureBudget(players.length);
    players.each((_, element) => {
      const player = $(element), anchor = player.find('.sidearm-roster-player-name a').first(), image = player.find('.sidearm-roster-player-image img').first();
      const path = anchor.attr('href');
      if (!path || !matchSportRoute(path, sport)) throw new Error('Static roster player sport scope is unverified');
      add({ name: anchor.text(), path, position: player.find('.sidearm-roster-player-position-long-short, .sidearm-roster-player-position span').first().text(),
        jersey: player.find('.sidearm-roster-player-jersey-number').first().text(), year: player.find('.sidearm-roster-player-academic-year').first().text(),
        image: image.attr('data-src') || image.attr('src') });
    });
  }
  return finish(records, season, emptyConfirmed);
}

function resultScore(value) {
  const text = scalar(value);
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number < 10000 ? number : null;
}
function staticDay(card, $) {
  const time = card.find('time[datetime]').first().attr('datetime');
  if (time) return dayValue(time);
  // Sidearm's accessible toggle carries a full calendar date; displayed
  // month/day alone is insufficient for schedules spanning two years.
  const toggle = card.find('.sidearm-schedule-game-toggle').first().text().trim();
  const label = toggle.match(/-\s*([A-Za-z]+ \d{1,2},? \d{4})\s*$/)?.[1]
    || card.find('[aria-label]').map((_, element) => $(element).attr('aria-label')).get().map(label => label.match(/\bon ([A-Za-z]+ \d{1,2},? \d{4})\b/)?.[1]).find(Boolean);
  if (!label) return null;
  const ms = Date.parse(`${label} 00:00:00 GMT`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseOfficialSchedule(text, sourceUrl, school, sport) {
  const { $, scopedUrl } = document(text, sourceUrl, school);
  requireSourceRoute(sourceUrl, sport, 'schedule');
  const graph = nuxt($), records = [];
  let season = seasonValue($, 'schedule'), candidates = 0, emptyConfirmed = false;
  const add = ({ id, date, opponent, status, venue, homeAway, teamScore, opponentScore, path }) => {
    ensureBudget(++candidates);
    opponent = tidy(opponent);
    if (!date || !opponent) throw new Error('Official schedule date or opponent is unrecognized');
    records.push({ id: stableId(school.slug, sport.slug, id || `${date}|${opponent}`), date, datePrecision: 'day',
      name: `${cleanText(school.name, 100)} ${homeAway === 'away' ? 'at' : 'vs'} ${opponent}`, status: tidy(status, 80) || 'Scheduled',
      venue: tidy(venue), homeAway: ['home', 'away', 'neutral'].includes(homeAway) ? homeAway : null, opponent,
      teamScore: resultScore(teamScore), opponentScore: resultScore(opponentScore), url: path ? scopedUrl(path) : null });
  };
  if (graph) for (const node of graph.nodes) {
    if (!own(node, 'games') || !own(node, 'season') || !own(node, 'sport')) continue;
    if (!structuredSportMatches(graph, graph.object(node, 'sport'), sport)) continue;
    const games = graph.list(node, 'games');
    if (!games) throw new Error('Official schedule games shape changed');
    season = graph.field(graph.object(node, 'season'), 'title') || season;
    if (!games.length) emptyConfirmed = true;
    for (const game of games) {
      const result = graph.object(game, 'result'), resultStatus = graph.field(result, 'status');
      const resultText = ({ W: 'Final - Win', L: 'Final - Loss', T: 'Final - Tie' })[resultStatus];
      const state = graph.field(game, 'noplay_text') || resultText || graph.field(game, 'game_state_display');
      add({ id: graph.field(game, 'id'), date: dayValue(graph.field(game, 'date')), opponent: graph.field(graph.object(game, 'opponent'), 'title'),
        status: state, venue: graph.field(graph.object(game, 'facility'), 'title') || graph.field(game, 'location'),
        homeAway: ({ H: 'home', A: 'away', N: 'neutral' })[graph.field(game, 'location_indicator')],
        teamScore: graph.field(result, 'team_score'), opponentScore: graph.field(result, 'opponent_score'), path: graph.field(game, 'game_center_link') });
    }
  }
  if (!records.length && !emptyConfirmed) {
    const games = $('.sidearm-schedule-game');
    ensureBudget(games.length);
    games.each((_, element) => {
      const game = $(element), result = game.find('.sidearm-schedule-game-result').first().text().replace(/\s+/g, ' ').trim();
      const scores = result.match(/(?:^|[, ])(\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)(?:\b|$)/);
      const location = game.attr('class')?.match(/sidearm-schedule-game-(home|away|neutral)\b/)?.[1]
        || game.attr('class')?.match(/sidearm-schedule-(home|away|neutral)-game\b/)?.[1];
      add({ date: staticDay(game, $), opponent: game.find('.sidearm-schedule-game-opponent-name').first().text(), status: result || 'Scheduled',
        venue: game.find('.sidearm-schedule-game-location').first().text(), homeAway: location,
        teamScore: scores?.[1], opponentScore: scores?.[2], path: game.find('.sidearm-schedule-game-links-recap a, .sidearm-schedule-game-links-boxscore a').first().attr('href') });
    });
  }
  return finish(records.sort((a, b) => a.date.localeCompare(b.date)), season, emptyConfirmed);
}
