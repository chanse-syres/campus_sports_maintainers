/** Import only public institutional membership and sport sponsorship fields. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { load } from 'cheerio';

const ROOT = new URL('../../', import.meta.url);
const DIRECTORY = 'https://web3.ncaa.org/directory/';
const MEMBER_SOURCE = `${DIRECTORY}api/directory/memberList?type=12&division=I`;
const SPORTS_SOURCE = `${DIRECTORY}api/common/sportList`;
const COMPOSITION_SOURCE = 'https://www.ncaa.org/about-us/membership-directory/membership-composition-and-sport-sponsorship/';
const CONCURRENCY = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const BIG_12_SLUGS = {
  29: 'arizona', 28: 'arizona-state', 51: 'baylor', 77: 'byu', 140: 'cincinnati',
  157: 'colorado', 288: 'houston', 311: 'iowa-state', 328: 'kansas', 327: 'kansas-state',
  521: 'oklahoma-state', 698: 'tcu', 700: 'texas-tech', 128: 'ucf', 732: 'utah', 768: 'west-virginia',
};

export function slugify(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function sportSlug(name, code) {
  if (code === 'MBB') return 'basketball';
  return slugify(name.replace(/^Mixed\s+/i, 'Coed '));
}

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

function conference(id, name) {
  const normalizedName = clean(name);
  if (!normalizedName) return null;
  return {
    id: id == null ? null : Number(id),
    slug: slugify(normalizedName.replace(/^The\s+/i, '').replace(/\s+Conference$/i, '')),
    name: normalizedName,
  };
}

/** Normalize the NCAA-provided URL only; never invent an athletics hostname. */
export function athleticsUrl(raw) {
  if (!clean(raw)) return null;
  const value = clean(raw);
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || isIP(url.hostname) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) {
    throw new Error('Invalid public NCAA athletics URL');
  }
  url.protocol = 'https:';
  url.hash = '';
  return url.href;
}

async function fetchPublic(url) {
  const target = new URL(url);
  if (target.origin !== new URL(DIRECTORY).origin || !target.pathname.startsWith('/directory/')) {
    throw new Error('Catalog requests must use the exact public NCAA directory origin and path');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(target, {
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'CampusSportsCatalog/1.0 (public institutional metadata)', Accept: 'text/html,application/json' },
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      const seconds = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : (attempt + 1) * 2000));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`NCAA public request failed with status ${response.status}`);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('NCAA response exceeded catalog size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('NCAA public request retries exhausted');
}

/** Read just table cells 0, 2, and 3. Coach and staff information is never retained. */
export function parseSponsoredSports(html, academicYear, sportMap, sourceUrl) {
  const $ = load(html);
  const headings = $('.panel-heading').filter((_, el) => clean($(el).text()).startsWith('Sponsored Sports for the'));
  if (headings.length !== 1) throw new Error('Expected exactly one public Sponsored Sports panel');
  const heading = clean(headings.text());
  if (!heading.includes(`${academicYear - 1}-${academicYear}`)) throw new Error('NCAA sport academic year does not match membership year');
  const table = headings.parent().children('table').first();
  const headers = table.find('tr').first().find('th').map((_, el) => clean($(el).text())).get();
  if (headers[0] !== 'Sport' || headers[2] !== 'Division' || headers[3] !== 'Conference') throw new Error('NCAA sponsored sport table shape changed');
  const sports = [];
  table.find('tr').each((_, row) => {
    const cells = $(row).children('td');
    if (!cells.length) return;
    const name = clean(cells.eq(0).text());
    const code = sportMap.get(name);
    if (!code) throw new Error(`Unrecognized public NCAA sport label: ${name}`);
    const confCell = cells.eq(3);
    const confHref = confCell.find('a').first().attr('href');
    const confId = confHref ? new URL(confHref, DIRECTORY).searchParams.get('id') : null;
    sports.push({
      code, slug: sportSlug(name, code), name,
      gender: ({ M: 'men', W: 'women', X: 'coed' })[code[0]],
      conference: conference(confId, confCell.text()),
      division: clean(cells.eq(2).text()) || null,
      sourceUrl,
    });
  });
  const unique = new Map();
  for (const sport of sports) {
    const existing = unique.get(sport.code);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sport)) throw new Error(`Conflicting duplicate sponsorship rows: ${sourceUrl}; ${sport.code}`);
    unique.set(sport.code, sport);
  }
  // The public table can repeat a sport when it lists multiple head coaches.
  // Identical institutional sport metadata is one sponsorship, regardless of staff rows.
  return { sports: [...unique.values()].sort((a, b) => a.slug.localeCompare(b.slug)), duplicateRows: sports.length - unique.size };
}

async function mapLimited(items, fn) {
  let next = 0;
  let failure;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); }
      catch (error) { failure = error; }
      // Bound concurrency and add a small delay between public page requests.
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }));
  if (failure) throw failure;
  return results;
}

function countBy(items, field) {
  return Object.fromEntries([...items.reduce((map, item) => {
    const key = field(item); map.set(key, (map.get(key) ?? 0) + 1); return map;
  }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export async function importCatalog() {
  const requestedYear = process.argv.find(arg => arg.startsWith('--academic-year='))?.split('=')[1];
  const retrievedAt = new Date().toISOString();
  const [memberText, sportText] = await Promise.all([fetchPublic(MEMBER_SOURCE), fetchPublic(SPORTS_SOURCE)]);
  const members = JSON.parse(memberText);
  const sportLabels = JSON.parse(sportText);
  if (!Array.isArray(members) || !members.length || !Array.isArray(sportLabels)) throw new Error('Unexpected NCAA catalog JSON shape');
  if (new Set(members.map(m => m.orgId)).size !== members.length) throw new Error('Duplicate NCAA institution IDs');
  const years = [...new Set(members.map(m => m.academicYear))];
  if (years.length !== 1 || !Number.isInteger(years[0])) throw new Error('NCAA membership spans inconsistent academic years');
  const academicYear = years[0];
  if (requestedYear && Number(requestedYear) !== academicYear) throw new Error('Requested academic year does not match the live NCAA directory');
  const sportMap = new Map(sportLabels.map(s => [clean(s.label), s.value]));
  if (sportMap.size !== sportLabels.length) throw new Error('Duplicate NCAA sport labels');
  let previousSlugs = new Map();
  try {
    const previous = JSON.parse(await readFile(new URL('catalog/membership.json', ROOT), 'utf8'));
    previousSlugs = new Map(previous.schools.map(s => [s.ncaaId, s.slug]));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exclusions = [];
  const schools = [];
  const repeatedSportRows = [];
  let completed = 0;
  await mapLimited(members, async member => {
    if (member.deactive !== 'N' || (member.division !== 1 && member.reclassDivision !== 1)) throw new Error('Unexpected institution in NCAA Division I search');
    const sourceUrl = `${DIRECTORY}orgDetail?id=${member.orgId}`;
    const html = await fetchPublic(sourceUrl);
    const { sports, duplicateRows } = parseSponsoredSports(html, academicYear, sportMap, sourceUrl);
    if (duplicateRows) repeatedSportRows.push({ ncaaId: member.orgId, identicalDuplicateRowsRemoved: duplicateRows, sourceUrl });
    const url = athleticsUrl(member.athleticWebUrl);
    const basic = { ncaaId: member.orgId, name: clean(member.nameOfficial), sourceUrl };
    if (member.division === 1 && member.reclassDivision && member.reclassDivision !== 1) {
      if (sports.some(s => ['I', 'FBS', 'FCS'].includes(s.division))) throw new Error('Outgoing reclassifying school still sponsors Division I sports; review scope');
      exclusions.push({ ...basic, reason: 'Reclassifying out of Division I; all current sponsored sports are outside Division I.', currentDivision: 'I', reclassifyingTo: member.reclassDivision, sponsoredSportCount: sports.length, sportDivisions: [...new Set(sports.map(s => s.division))] });
    } else if (!url && !sports.length) {
      exclusions.push({ ...basic, reason: 'Directory entry has no athletics URL and no current sponsored sports; cannot establish a varsity athletics program.', sponsoredSportCount: 0 });
    } else {
      if (!sports.length) throw new Error(`Real institution has no sponsored sports: NCAA ${member.orgId}`);
      schools.push({
        ...basic,
        slug: previousSlugs.get(member.orgId) ?? BIG_12_SLUGS[member.orgId] ?? slugify(basic.name),
        status: member.reclassDivision === 1 && member.division !== 1 ? 'reclassifying' : 'active',
        division: ({ 1: 'I', 2: 'II', 3: 'III' })[member.division],
        subdivision: ({ 1: 'FBS', 2: 'FCS' })[member.subdivision] ?? null,
        reclassification: member.reclassDivision ? { division: ({ 1: 'I', 2: 'II', 3: 'III' })[member.reclassDivision], subdivision: ({ 1: 'FBS', 2: 'FCS' })[member.reclassSubdivision] ?? null, year: member.reclassYear } : null,
        athleticsUrl: url,
        conference: conference(member.conferenceId, member.conferenceName),
        sports,
      });
    }
    completed++;
    if (completed % 25 === 0 || completed === members.length) process.stdout.write(`Parsed NCAA public sponsorships: ${completed}/${members.length}\n`);
  });
  schools.sort((a, b) => a.name.localeCompare(b.name));
  exclusions.sort((a, b) => a.ncaaId - b.ncaaId);
  if (new Set(schools.map(s => s.slug)).size !== schools.length) throw new Error('School slug collision; add a reviewed stable alias');
  const allSports = schools.flatMap(s => s.sports);
  const sportCatalog = [...new Map(allSports.map(s => [s.code, { code: s.code, slug: s.slug, name: s.name, gender: s.gender }])).values()].sort((a, b) => a.slug.localeCompare(b.slug));
  if (new Set(sportCatalog.map(s => s.slug)).size !== sportCatalog.length) throw new Error('Sport slug collision');
  const missingAthletics = schools.filter(s => !s.athleticsUrl).map(s => s.ncaaId);
  const missingConference = schools.filter(s => !s.conference).map(s => s.ncaaId);
  const catalog = {
    schemaVersion: 1, academicYear: `${academicYear - 1}-${String(academicYear).slice(-2)}`,
    retrievedAt, sourceUrl: `${DIRECTORY}memberList?type=12&division=I`,
    sourceApiUrl: MEMBER_SOURCE, sportCodesSourceUrl: SPORTS_SOURCE,
    scope: 'Active NCAA Division I institutions and institutions reclassifying into Division I; all current sports listed by the NCAA, including non-championship and coed sports. Institutions reclassifying out with no Division I sports are excluded.',
    schools,
  };
  const evidence = {
    schemaVersion: 1, academicYear: catalog.academicYear, retrievedAt,
    sources: [catalog.sourceUrl, MEMBER_SOURCE, SPORTS_SOURCE, COMPOSITION_SOURCE],
    rawDivisionISearchCount: members.length,
    includedSchoolCount: schools.length,
    schoolStatusCounts: countBy(schools, s => s.status),
    sponsorshipCount: allSports.length, distinctSportCount: sportCatalog.length,
    primaryConferenceCount: new Set(schools.map(s => s.conference?.id).filter(id => id != null)).size,
    sportGenderCounts: countBy(allSports, s => s.gender),
    sportDivisionCounts: countBy(allSports, s => s.division ?? 'unspecified'),
    sportConferenceMissingCount: allSports.filter(s => !s.conference).length,
    sportAffiliateConferenceCount: schools.reduce((count, s) => count + s.sports.filter(sport => sport.conference && sport.conference.id !== s.conference?.id).length, 0),
    duplicateSchoolIds: 0, duplicateSchoolSlugs: 0, duplicateSchoolSportCodes: 0,
    repeatedSourceSportRows: repeatedSportRows.sort((a, b) => a.ncaaId - b.ncaaId),
    missingAthleticsSchoolIds: missingAthletics, missingPrimaryConferenceSchoolIds: missingConference,
    exclusions,
    limitations: [
      'NCAA directory sport sponsorship is self-reported institutional data; changes not yet reported to the NCAA may be absent.',
      'The directory includes non-championship sports such as crew and sailing, but does not establish that every institution reports every varsity sport.',
      'An absent sport conference is retained as null. It is not inferred from the primary institutional conference.',
      'Athletics URL hostnames come directly from the NCAA directory; HTTPS is normalized but redirects are left for source discovery to verify.',
    ],
  };
  await mkdir(new URL('catalog/', ROOT), { recursive: true });
  for (const [name, value] of Object.entries({ 'membership.json': catalog, 'sports.json': { schemaVersion: 1, academicYear: catalog.academicYear, sourceUrl: SPORTS_SOURCE, sports: sportCatalog }, 'import-evidence.json': evidence })) {
    await writeFile(new URL(`catalog/${name}`, ROOT), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ schoolCount: schools.length, sponsorships: allSports.length, sports: sportCatalog.length, exclusions: exclusions.map(e => e.ncaaId) })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`))) {
  importCatalog().catch(error => { console.error(`Catalog import failed: ${error.message}`); process.exitCode = 1; });
}
