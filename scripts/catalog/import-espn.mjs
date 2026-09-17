import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ESPN_PATHS } from '../../src/providers.mjs';
import { fetchSourceText } from '../../src/network.mjs';
import { cleanText, safeUrl } from '../../src/normalize.mjs';

// Normalization removes institutional boilerplate only. No fuzzy matching,
// abbreviation expansion, mascot stripping, or cross-sport ID inheritance.
export const normalizeSchoolName = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\b(?:university|college|the|of)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const literalName = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

export function matchEspnSchool(school, schools, teams, aliases = []) {
  const exact = normalizeSchoolName(school.name);
  const names = new Set([exact, ...aliases.map(normalizeSchoolName)]);
  // Preserve distinctions such as Boston College / Boston University before
  // considering institutional boilerplate normalization.
  const literalMatches = teams.filter(team => [school.name, ...aliases].some(name => literalName(name) === literalName(team.location)));
  const candidates = literalMatches.length ? literalMatches : teams.filter(team => names.has(normalizeSchoolName(team.location)));
  if (candidates.length !== 1) return { status: 'unmapped', reason: candidates.length ? 'ambiguous-provider-school-name' : 'no-exact-or-reviewed-alias-match' };
  const candidate = candidates[0];
  if (!literalMatches.length && !aliases.some(alias => normalizeSchoolName(alias) === normalizeSchoolName(candidate.location)) && schools.filter(other => normalizeSchoolName(other.name) === exact).length !== 1) return { status: 'unmapped', reason: 'ambiguous-ncaa-school-name' };
  return { status: 'verified', espnId: candidate.id, espnName: candidate.location, matchMethod: normalizeSchoolName(candidate.location) === exact ? 'exact-normalized-name' : 'reviewed-name-alias' };
}

const RANKINGS_VIEW = '~/Views/SkyNet/InstitutionRanking/_SimpleSetForSeason.ascx';
export function parseRecruitingInventory(text, sourceUrl, year, sport) {
  if (typeof text !== 'string' || text.length > 2_000_000 || /Sorry, you have been blocked|Attention Required!|Just a moment\.\.\./i.test(text)) throw new Error('invalid-recruiting-inventory');
  const $ = load(text), candidates = [];
  for (const element of $('a.rankings-page__name-link').toArray()) {
    const href = safeUrl($(element).attr('href'), sourceUrl);
    const url = href && new URL(href);
    const match = url?.pathname.match(/^\/college\/([a-z0-9-]+)\/season\/(\d{4})-(football|basketball|womens-basketball)\/commits\/$/i);
    const name = cleanText($(element).text(), 160);
    // Some provider rows omit the college slug. They cannot create a mapping.
    if (url?.hostname !== '247sports.com' || url.search || url.hash || !match || Number(match[2]) !== year || match[3].toLowerCase() !== sport || !name) continue;
    candidates.push({ recruitingSlug: match[1].toLowerCase(), recruitingName: name, sourceUrl, observedUrl: url.href });
  }
  const nextLinks = $('a').filter((_, element) => cleanText($(element).text(), 80) === 'Load More');
  if (nextLinks.length > 1 || candidates.length > 500) throw new Error('ambiguous-recruiting-inventory');
  let nextUrl = null;
  if (nextLinks.length) {
    const href = safeUrl(nextLinks.attr('href'), sourceUrl), url = href && new URL(href);
    const expectedPath = `/season/${year}-${sport}/compositeteamrankings/`;
    if (!url || url.hostname !== '247sports.com' || url.pathname.toLowerCase() !== expectedPath || url.hash
      || [...url.searchParams.keys()].sort().join(',') !== 'Page,ViewPath' || url.searchParams.get('ViewPath') !== RANKINGS_VIEW
      || !/^(?:[2-9]|10)$/.test(url.searchParams.get('Page') ?? '')) throw new Error('invalid-recruiting-inventory-continuation');
    nextUrl = url.href;
  }
  return { candidates, nextUrl };
}

export async function discoverRecruitingSchools({ get, year }) {
  const candidates = new Map(), checks = [];
  for (const season of [year, year - 1]) for (const sport of ['football', 'basketball', 'womens-basketball']) {
    let sourceUrl = `https://247sports.com/Season/${season}-${sport}/CompositeTeamRankings/`;
    const fetched = new Set();
    try {
      while (sourceUrl) {
        if (fetched.has(sourceUrl) || fetched.size >= 10) throw new Error('recruiting-inventory-page-budget');
        fetched.add(sourceUrl);
        const text = await get(sourceUrl), page = parseRecruitingInventory(text, sourceUrl, season, sport);
        checks.push({ sourceUrl, status: 'verified', count: page.candidates.length, sha256: createHash('sha256').update(text).digest('hex') });
        for (const candidate of page.candidates) {
          const previous = candidates.get(candidate.recruitingSlug);
          if (previous && previous.recruitingName !== candidate.recruitingName) previous.ambiguous = true;
          else if (!previous) candidates.set(candidate.recruitingSlug, candidate);
        }
        sourceUrl = page.nextUrl;
      }
    } catch (error) { checks.push({ sourceUrl, status: 'unavailable', reason: error.code ?? error.message }); }
  }
  return { candidates: [...candidates.values()].filter(value => !value.ambiguous), checks };
}

export async function importProviders({ get = url => fetchSourceText(url, { allowedHosts: ['site.api.espn.com', '247sports.com'], maxBytes: 8_000_000 }), recruiting = false } = {}) {
  const membership = JSON.parse(await readFile(new URL('../../catalog/membership.json', import.meta.url), 'utf8'));
  let previous = {};
  try { previous = JSON.parse(await readFile(new URL('../../catalog/providers.json', import.meta.url), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const registry = { schemaVersion: 1, retrievedAt: new Date().toISOString(), membershipAcademicYear: membership.academicYear,
    policy: 'Exact normalized NCAA names or reviewed aliases only; sport IDs come from that sport inventory. Unmapped programs remain explicit. Provider inventories can include non-DI schools and never define NCAA membership.',
    reviewedAliases: previous.reviewedAliases ?? {}, leagues: {}, schools: {} };
  for (const school of membership.schools) registry.schools[school.slug] = { ncaaId: school.ncaaId, espn: {}, recruiting: previous.schools?.[school.slug]?.recruiting ?? null };
  const sports = Object.entries(ESPN_PATHS);
  for (let offset = 0; offset < sports.length; offset += 3) {
    await Promise.all(sports.slice(offset, offset + 3).map(async ([sport, espnPath]) => {
      const sourceUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/teams?limit=1000`;
      const report = { espnPath, sourceUrl, retrievedAt: registry.retrievedAt, status: 'unavailable', teams: [], news: null };
      registry.leagues[sport] = report;
      try {
        const text = await get(sourceUrl), data = JSON.parse(text);
        const [sportPath, leaguePath] = espnPath.split('/');
        const root = data.sports?.[0], league = root?.leagues?.[0];
        if (root?.slug !== sportPath || league?.slug !== leaguePath || !/^\d+$/.test(String(league.id)) || !Array.isArray(league.teams) || league.teams.length > 1000) throw new Error('inventory-identity-or-size-mismatch');
        const placeholders = league.teams.filter(({ team }) => /^-[12]$/.test(team?.id) && team.location === 'TBD' && team.displayName === 'TBD TBD');
        const entries = league.teams.filter(entry => !placeholders.includes(entry)).map(({ team }) => {
          if (!/^\d+$/.test(team?.id) || typeof team.location !== 'string' || !team.location || team.location.length > 200 || typeof team.displayName !== 'string') throw new Error('invalid-team-inventory');
          return { id: team.id, location: team.location, displayName: cleanText(team.displayName, 200) };
        });
        const byId = new Map();
        for (const team of entries) {
          if (byId.has(team.id) && JSON.stringify(byId.get(team.id)) !== JSON.stringify(team)) throw new Error('conflicting-team-inventory');
          byId.set(team.id, team);
        }
        const teams = [...byId.values()];
        Object.assign(report, { status: teams.length ? 'verified' : 'empty-inventory', leagueId: Number(league.id), leagueName: cleanText(league.name, 200), teamCount: teams.length, excludedPlaceholderCount: placeholders.length, excludedDuplicateCount: entries.length - teams.length, sha256: createHash('sha256').update(text).digest('hex'), teams });
        for (const school of membership.schools.filter(school => school.sports.some(program => program.slug === sport))) {
          const aliases = registry.reviewedAliases[String(school.ncaaId)]?.espn ?? [];
          const match = matchEspnSchool(school, membership.schools, teams, aliases);
          registry.schools[school.slug].espn[sport] = { ...match, espnPath, sourceUrl, ...(match.status === 'verified' ? { verifiedNameAliases: aliases, verifiedAt: registry.retrievedAt } : {}) };
        }
        const newsUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/news?limit=100`;
        try {
          const news = JSON.parse(await get(newsUrl));
          const link = safeUrl(news.link?.href);
          if (typeof news.header !== 'string' || news.header.length > 200 || !link || !['www.espn.com', 'espn.com'].includes(new URL(link).hostname) || !Array.isArray(news.articles) || news.articles.length > 200) throw new Error('invalid-news-feed-identity');
          report.news = { sourceUrl: newsUrl, header: news.header, leagueIndexUrl: link, verifiedAt: registry.retrievedAt };
        } catch (error) { report.newsReason = error.code ?? error.message; }
      } catch (error) { report.reason = error.code ?? error.message; }
      console.log(JSON.stringify({ sport, status: report.status, teams: report.teamCount ?? 0, news: Boolean(report.news), reason: report.reason }));
    }));
  }
  if (recruiting) {
    const year = Number(membership.academicYear.slice(0, 4)) + 1;
    const inventory = await discoverRecruitingSchools({ get, year });
    registry.recruitingInventories = inventory.checks;
    for (let offset = 0; offset < inventory.candidates.length; offset += 3) {
      await Promise.all(inventory.candidates.slice(offset, offset + 3).map(async ({ recruitingSlug, recruitingName, sourceUrl: inventorySourceUrl }) => {
        const names = school => [school.name, ...(registry.reviewedAliases[String(school.ncaaId)]?.espn ?? [])];
        const literalMatches = membership.schools.filter(school => names(school).some(name => literalName(name) === literalName(recruitingName)));
        const schools = literalMatches.length ? literalMatches : membership.schools.filter(school => names(school).some(name => normalizeSchoolName(name) === normalizeSchoolName(recruitingName)));
        if (schools.length !== 1) return;
        const school = schools[0], checks = [], verifiedSports = [];
        for (const sport of ['football', 'basketball', 'womens-basketball'].filter(sport => school.sports.some(program => program.slug === sport))) {
          const sourceUrl = `https://247sports.com/college/${recruitingSlug}/season/${year}-${sport}/commits/`;
          try {
            const text = await get(sourceUrl), $ = load(text);
            if (text.length > 2_000_000 || /Sorry, you have been blocked|Attention Required!|Just a moment\.\.\./i.test(text)) throw new Error('access-challenge');
            const label = sport === 'football' ? 'Football' : sport === 'basketball' ? 'Basketball' : "Women's Basketball";
            if ($('link[rel="canonical"]').length !== 1 || $('link[rel="canonical"]').attr('href')?.toLowerCase() !== sourceUrl || !cleanText($('h1').first().text(), 300).startsWith(`${recruitingName} ${year} ${label} Commits (`)) throw new Error('source-scope-mismatch');
            verifiedSports.push(sport); checks.push({ sport, sourceUrl, status: 'verified', verifiedAt: registry.retrievedAt });
          } catch (error) { checks.push({ sport, sourceUrl, status: 'unavailable', reason: error.code ?? error.message, checkedAt: registry.retrievedAt }); }
        }
        if (verifiedSports.length) registry.schools[school.slug].recruiting = { recruitingSlug, recruitingName, sports: verifiedSports, checks, inventorySourceUrl, verifiedAt: registry.retrievedAt, coverage: 'Provider-reported recruiting only. Womens basketball provider coverage is incomplete.' };
        else registry.schools[school.slug].recruitingChecks = checks;
        console.log(JSON.stringify({ recruiting: school.slug, verifiedSports }));
      }));
    }
  }
  for (const school of membership.schools) for (const sport of school.sports) {
    registry.schools[school.slug].espn[sport.slug] ??= { status: 'unmapped', reason: registry.leagues[sport.slug]?.reason ?? 'no-verified-league-inventory' };
  }
  // Save only after the complete bounded import; never write a half-built catalog.
  await writeFile(new URL('../../catalog/providers.json', import.meta.url), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return registry;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await importProviders({ recruiting: process.argv.includes('--recruiting') });
