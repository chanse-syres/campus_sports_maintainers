import { load } from 'cheerio';
import { readFileSync } from 'node:fs';
import { safeUrl, cleanText } from './normalize.mjs';
import { matchSport, matchSportRoute, matchNavigationSport, normalizeSportLabel } from './sports.mjs';

const collectionPattern = /\/(?:roster|schedule|archives|news|coaches|stats|statistics)(?:\/|$)/i;
const overrides = JSON.parse(readFileSync(new URL('../catalog/source-overrides.json', import.meta.url), 'utf8'));
function sportRoute(url) {
  const parsed = new URL(url), pathname = parsed.pathname;
  const match = pathname.match(/^(\/sports?)\/([a-z][a-z0-9-]*)(?:\/|$)/i);
  if (match && !['mens', 'womens', 'schedule', 'roster', 'rosters', 'stats', 'coaches'].includes(match[2])) return `${match[1]}/${match[2]}`;
  const path = parsed.searchParams.get('path');
  return /^\/index\.aspx$/i.test(pathname) && /^[a-z][a-z0-9-]*$/.test(path ?? '') ? `/index.aspx?path=${path}` : null;
}
function navLabel(text) {
  return text.replace(/^(?:roster|schedule|news|coaches|stats|statistics) for\s+/i, '')
    .replace(/\s*:\s*(?:roster|schedule|news|coaches|stats|statistics|home|tickets).*$/i, '').trim();
}

export function officialHosts(athleticsUrl) {
  if (!safeUrl(athleticsUrl)) return [];
  const host = new URL(athleticsUrl).hostname;
  return [...new Set([host, host.startsWith('www.') ? host.slice(4) : `www.${host}`])];
}

export function sourcePolicy(school) {
  const override = overrides.schools[school.slug];
  if (override && (override.ncaaId !== school.ncaaId || override.originalUrl !== school.athleticsUrl || !safeUrl(override.athleticsUrl) || !safeUrl(override.evidenceUrl))) throw new Error('Official source override identity mismatch');
  const allowedHosts = [...new Set([...officialHosts(school.athleticsUrl), ...officialHosts(override?.athleticsUrl)])];
  if (override?.newsFallbackUrl && (!safeUrl(override.newsFallbackUrl) || !allowedHosts.includes(new URL(override.newsFallbackUrl).hostname))) throw new Error('Official news fallback host mismatch');
  return { athleticsUrl: override?.athleticsUrl ?? school.athleticsUrl,
    newsFallbackUrl: override?.newsFallbackUrl ?? null, allowedHosts };
}

export function discoverEntrance(html, athleticsUrl) {
  const $ = load(html), hosts = officialHosts(athleticsUrl);
  if ($('a[href]').length > 15) return null;
  for (const element of $('a[href]').toArray()) {
    const label = cleanText($(element).text(), 80), url = officialLink($(element).attr('href'), athleticsUrl, hosts);
    if (url && /^(?:continue to (?:home|site)|enter (?:site|website))$/i.test(label) && /^\/(?:index\.aspx)?$/.test(new URL(url).pathname)) return url;
  }
  return null;
}

export async function discoverFromSitemap(school, get) {
  const policy = sourcePolicy(school), robotsUrl = new URL('/robots.txt', policy.athleticsUrl).href;
  const robots = await get(robotsUrl);
  if (typeof robots !== 'string' || robots.length > 100_000) return null;
  const sitemapUrl = robots.split(/\r?\n/).map(line => line.match(/^Sitemap:\s*(https:\/\/\S+)\s*$/i)?.[1])
    .map(url => officialLink(url, robotsUrl, policy.allowedHosts)).find(Boolean);
  if (!sitemapUrl) return null;
  const xml = load(await get(sitemapUrl), { xml: true });
  const locations = xml('loc').toArray().slice(0, 1000).map(element => officialLink(xml(element).text(), sitemapUrl, policy.allowedHosts)).filter(Boolean);
  const child = locations.find(url => /sitemap_(?:schedule|roster)_1\.xml$/.test(new URL(url).pathname));
  const pageXml = child ? load(await get(child), { xml: true }) : xml;
  const pageUrl = pageXml('loc').toArray().slice(0, 3000).map(element => officialLink(pageXml(element).text(), child ?? sitemapUrl, policy.allowedHosts))
    .find(url => url && /^\/sports?\/[a-z][a-z0-9-]*\/(?:schedule|roster)(?:\/|$)/.test(new URL(url).pathname));
  if (!pageUrl) return null;
  return { html: await get(pageUrl), sourceUrl: pageUrl };
}
function officialLink(value, sourceUrl, hosts) {
  const url = safeUrl(value, sourceUrl);
  if (!url || !hosts.includes(new URL(url).hostname)) return null;
  const parsed = new URL(url);
  parsed.hash = '';
  if (/\.(pdf|jpg|png|gif|mp4|zip)$/i.test(parsed.pathname)) return null;
  return parsed.href;
}
export function discoverSchoolSources(html, school, sourceUrl = school.athleticsUrl) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 8_000_000) throw new Error('Invalid navigation document');
  const policy = sourcePolicy(school), allowedHosts = policy.allowedHosts;
  if (!allowedHosts.includes(new URL(sourceUrl).hostname)) throw new Error('Navigation host mismatch');
  const $ = load(html), links = [];
  for (const anchor of $('a[href]').toArray().slice(0, 6000)) {
    const el = $(anchor), url = officialLink(el.attr('href'), sourceUrl, allowedHosts);
    if (!url) continue;
    const text = navLabel(cleanText(el.attr('aria-label') || el.text(), 160));
    const title = navLabel(cleanText(el.attr('title'), 160));
    // Nearest sport menu item can supply a full gender-specific sport label.
    const item = el.closest('li');
    const parentLabel = cleanText(item.children('a,span,button').first().text(), 160);
    const sectionLabel = item.prevAll('li').toArray().map(node => cleanText($(node).children('span,h2,h3,button').first().text(), 60)).find(label => /^(?:men'?s|women'?s) sports$/i.test(label));
    const group = (sectionLabel || cleanText(item.parent().closest('li').children('a,span,button').first().text(), 160)).replace(/\s+sports$/i, '');
    links.push({ url, text, title, parentLabel, group,
      routeSports: new Set(school.sports.filter(sport => matchSportRoute(url, sport)).map(sport => sport.slug)),
      labelSports: new Set(school.sports.filter(sport => [text, title].some(label => matchNavigationSport(label, sport, school.sports))).map(sport => sport.slug)) });
  }
  const sports = {};
  for (const sport of school.sports) {
    const matches = links.filter(link => {
      const routeMatch = link.routeSports.has(sport.slug);
      if (link.labelSports.size && !link.labelSports.has(sport.slug)) return false;
      // An explicit URL for the other gender/sport outranks a surrounding menu label.
      // Some Sidearm schools assign the generic mens-rowing route to their
      // lightweight team. An explicit Lightweight Rowing menu label resolves
      // that known same-gender variant; it never overrides a gendered route.
      const explicitLightweight = sport.slug === 'mens-lightweight-crew' && link.labelSports.has(sport.slug)
        && /^\/sports\/mens-rowing(?:\/|$)/.test(new URL(link.url).pathname);
      if (!routeMatch && link.routeSports.size && !explicitLightweight) return false;
      const gender = /^(?:mens|womens)$/.test(normalizeSportLabel(link.group)) ? link.group : '';
      return routeMatch || [link.text, link.title, link.parentLabel, `${gender} ${link.parentLabel}`, `${gender} ${link.text}`].some(label => matchNavigationSport(label, sport, school.sports));
    });
    const routeCandidate = matches.filter(link => sportRoute(link.url));
    const home = routeCandidate.find(link => !collectionPattern.test(new URL(link.url).pathname) && (/^\/sports?\/[^/]+\/?$/.test(new URL(link.url).pathname) || /^\/index\.aspx$/.test(new URL(link.url).pathname))) ?? routeCandidate[0];
    // Collection links establish a sport route, but a single article never
    // becomes an archive endpoint. Keep only URLs actually linked on the site.
    const homeUrl = home?.url ?? null;
    const sportPath = homeUrl ? sportRoute(homeUrl) : null;
    const inRoute = link => sportPath && (sportPath.includes('?') ? sportRoute(link.url) === sportPath : new URL(link.url).pathname === sportPath || new URL(link.url).pathname.startsWith(`${sportPath}/`));
    const scoped = links.filter(link => matches.includes(link) || inRoute(link));
    // Legacy index homes can link modern collection routes for the same sport.
    // Require an observed sport route so a matching single news article cannot
    // become the collection endpoint.
    const collectionRoute = link => inRoute(link) || (sportRoute(link.url) && link.routeSports.has(sport.slug));
    const find = (pattern, label) => scoped.find(link => collectionRoute(link) && (pattern.test(new URL(link.url).pathname) || label.test(link.text)))?.url ?? null;
    sports[sport.slug] = { homeUrl, newsUrl: find(/\/(?:archives|news)(?:\/|$)/i, /^(?:news|archives?)$/i) ?? homeUrl,
      rosterUrl: find(/\/roster(?:\/|$)/i, /^roster$/i), scheduleUrl: find(/\/schedule(?:\/|$)/i, /^schedule$/i),
      routes: sportPath ? [sportPath] : [], aliases: home ? [...new Set(matches.filter(inRoute).flatMap(link => [link.text, link.title, link.parentLabel]).filter(label => matchNavigationSport(label, sport, school.sports)))] : [], discoveryStatus: homeUrl ? 'discovered' : 'no-matching-official-navigation' };
    // A reviewed all-sports collection supplies a retrieval URL only. Do not
    // manufacture sport routes or aliases; each article still proves its scope.
    if (!sports[sport.slug].newsUrl && policy.newsFallbackUrl) {
      sports[sport.slug].newsUrl = policy.newsFallbackUrl;
      sports[sport.slug].discoveryStatus = 'reviewed-shared-news-source';
    }
  }
  return { athleticsUrl: school.athleticsUrl, allowedHosts, status: 'ok', sports };
}

export function enrichSportSources(html, school, sport, source, allowedHosts) {
  if (!source.homeUrl || typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 8_000_000) return source;
  const $ = load(html), result = { ...source };
  const homePath = new URL(source.homeUrl).pathname.replace(/\/$/, '');
  for (const anchor of $('a[href]').toArray().slice(0, 6000)) {
    const el = $(anchor), url = officialLink(el.attr('href'), source.homeUrl, allowedHosts);
    if (!url) continue;
    const pathname = new URL(url).pathname;
    const scoped = pathname.startsWith(`${homePath}/`) || matchSportRoute(url, { ...sport, routes: source.routes });
    if (!scoped) continue;
    if (/\/archives\/?$/.test(pathname)) result.newsUrl = url;
    if (/\/roster\/?$/.test(pathname)) result.rosterUrl = url;
    if (/\/schedule\/?$/.test(pathname)) result.scheduleUrl = url;
  }
  return result;
}
