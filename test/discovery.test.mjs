import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources, discoverEntrance, enrichSportSources, sourcePolicy } from '../src/discovery.mjs';
import { getSchool } from '../src/config.mjs';
import { matchSport, matchNavigationSport } from '../src/sports.mjs';
const men = { slug: 'basketball', name: 'Basketball', code: 'MBB', gender: 'men' };
const women = { slug: 'womens-basketball', name: 'Basketball', code: 'WBB', gender: 'women' };
const track = ['men', 'women'].flatMap(gender => ['indoor', 'outdoor'].map(season => ({ slug: `${gender}s-track-${season}`, name: `${season} Track`, gender })));
const school = { athleticsUrl: 'https://sports.example.edu/', sports: [men, women, ...track] };

test('reviewed sport archives replace empty shared collections without manufacturing program navigation', async () => {
  const targets = [
    ['arkansas-state-university', { football: 'https://www.astateredwolves.com/sports/football/archives' }],
    ['idaho-state-university', { 'womens-basketball': 'https://www.isubengals.com/sports/womens-basketball/archives' }],
    ['tennessee-technological-university', { baseball: 'https://www.ttusports.com/sports/bsb/headlines-featured', basketball: 'https://www.ttusports.com/sports/mbkb/headlines-featured', 'womens-basketball': 'https://www.ttusports.com/sports/wbkb/headlines-featured' }],
    ['u-s-air-force-academy', { basketball: 'https://goairforcefalcons.com/sports/mens-basketball/archives/', 'womens-basketball': 'https://goairforcefalcons.com/sports/womens-basketball/archives' }],
    ['middle-tennessee-state-university', { baseball: 'https://goblueraiders.com/sports/baseball/archives', 'womens-basketball': 'https://goblueraiders.com/sports/womens-basketball/archives' }],
    ['wake-forest-university', { baseball: 'https://godeacs.com/sports/baseball/archives', basketball: 'https://godeacs.com/sports/mens-basketball/archives/', 'womens-basketball': 'https://godeacs.com/sports/womens-basketball/archives' }],
    ['purdue-university', { 'womens-basketball': 'https://purduesports.com/sports/womens-basketball/news' }],
  ];
  for (const [slug, expected] of targets) {
    const canonical = await getSchool(slug), policy = sourcePolicy(canonical);
    const discovered = discoverSchoolSources('<main>No sport navigation</main>', canonical);
    assert.deepEqual(policy.sportNewsUrls, expected);
    assert.deepEqual(policy.allowedHosts.sort(), [new URL(canonical.athleticsUrl).hostname.replace(/^www\./, ''), `www.${new URL(canonical.athleticsUrl).hostname.replace(/^www\./, '')}`].sort());
    for (const [sport, url] of Object.entries(expected)) {
      assert.equal(discovered.sports[sport].newsUrl, url);
      assert.equal(discovered.sports[sport].homeUrl, null);
      assert.equal(discovered.sports[sport].rosterUrl, null);
      assert.deepEqual(discovered.sports[sport].routes, []);
      assert.deepEqual(discovered.sports[sport].aliases, []);
      assert.equal(discovered.sports[sport].discoveryStatus, 'reviewed-sport-news-source');
    }
    assert.throws(() => sourcePolicy({ ...canonical, ncaaId: 1 }), /identity mismatch/);
    assert.throws(() => sourcePolicy({ ...canonical, sports: [] }), /scope mismatch/);
    assert.throws(() => sourcePolicy({ ...canonical, athleticsUrl: 'https://other.example/' }), /identity mismatch/);
  }
});

test('reviewed news route survives deep enrichment without replacing other program endpoints', async () => {
  const canonical = await getSchool('purdue-university'), sport = canonical.sports.find(item => item.slug === 'womens-basketball');
  const source = { homeUrl: 'https://purduesports.com/sports/womens-basketball', newsUrl: 'https://purduesports.com/sports/womens-basketball/news', rosterUrl: null, scheduleUrl: null, routes: ['/sports/womens-basketball'] };
  const result = enrichSportSources('<a href="/sports/womens-basketball/archives">Old archive</a><a href="/sports/womens-basketball/roster">Roster</a>', canonical, sport, source, sourcePolicy(canonical).allowedHosts);
  assert.equal(result.newsUrl, source.newsUrl);
  assert.equal(result.homeUrl, source.homeUrl);
  assert.equal(result.rosterUrl, 'https://purduesports.com/sports/womens-basketball/roster');
});

test('Presto featured-news collections stay separate from index homes and opposite gender', () => {
  const html = `<a href="/sports/mbkb/schedule">Men's Basketball schedule</a>
    <a href="/sports/mbkb/index">Men's Basketball</a><a href="/sports/mbkb/headlines-featured">Men's Basketball News</a>
    <a href="/sports/wbkb/index">Women's Basketball</a><a href="/sports/wbkb/headlines-featured">Women's Basketball News</a>`;
  const result = discoverSchoolSources(html, school);
  assert.equal(result.sports.basketball.homeUrl, 'https://sports.example.edu/sports/mbkb/index');
  assert.equal(result.sports.basketball.newsUrl, 'https://sports.example.edu/sports/mbkb/headlines-featured');
  assert.equal(result.sports['womens-basketball'].homeUrl, 'https://sports.example.edu/sports/wbkb/index');
  assert.equal(result.sports['womens-basketball'].newsUrl, 'https://sports.example.edu/sports/wbkb/headlines-featured');
  assert.equal(result.sports.basketball.scheduleUrl, 'https://sports.example.edu/sports/mbkb/schedule');
  const enriched = enrichSportSources('<a href="/sports/mbkb/headlines-featured">News</a><a href="/sports/wbkb/headlines-featured">News</a>', school, men, { homeUrl: 'https://sports.example.edu/sports/mbkb/index', routes: ['/sports/mbkb'] }, ['sports.example.edu']);
  assert.equal(enriched.newsUrl, 'https://sports.example.edu/sports/mbkb/headlines-featured');
});

test('opposite-gender route outranks surrounding navigation labels', () => {
  const html = '<li><a href="/sports/mens-basketball">Men\'s Basketball</a><a href="/sports/womens-basketball">News</a></li>';
  const result = discoverSchoolSources(html, school);
  assert.equal(result.sports.basketball.homeUrl, 'https://sports.example.edu/sports/mens-basketball');
  assert.equal(result.sports['womens-basketball'].homeUrl, 'https://sports.example.edu/sports/womens-basketball');
});
test('combined track navigation supplies all sponsored seasons without creating basketball scope', () => {
  const result = discoverSchoolSources('<a href="/sports/track-and-field">Track &amp; Field</a><a href="/sports/track-and-field/archives">News</a>', school);
  for (const sport of track) {
    assert.equal(result.sports[sport.slug].newsUrl, 'https://sports.example.edu/sports/track-and-field/archives');
    assert.ok(result.sports[sport.slug].aliases.includes('Track & Field'));
  }
  assert.equal(result.sports.basketball.homeUrl, null);
});
test('ambiguous generic basketball is not assigned to both genders', () => {
  assert.equal(matchNavigationSport('Basketball', men, school.sports), false);
  assert.equal(matchSport('Basketball', men), false);
  assert.equal(matchNavigationSport('Basketball', women, [women]), true);
});
test('article links and unrelated external hosts never become archives', () => {
  const html = '<a href="/sports/mens-basketball">Men\'s Basketball</a><a href="/news/2026/9/16/mens-basketball-preview">News</a><a href="https://attacker.example/sports/womens-basketball">Women\'s Basketball</a>';
  const result = discoverSchoolSources(html, school);
  assert.equal(result.sports.basketball.newsUrl, 'https://sports.example.edu/sports/mens-basketball');
  assert.equal(result.sports['womens-basketball'].homeUrl, null);
});
test('school inventory disambiguates an ungendered wrestling navigation label', () => {
  const sport = { slug: 'mens-wrestling', name: 'Wrestling', gender: 'men' };
  const result = discoverSchoolSources('<a href="/sports/wrestling">Wrestling</a>', { ...school, sports: [sport] });
  assert.equal(result.sports[sport.slug].homeUrl, 'https://sports.example.edu/sports/wrestling');
  assert.deepEqual(result.sports[sport.slug].aliases, ['Wrestling']);
});
test('legacy index routes keep men and women separately scoped', () => {
  const result = discoverSchoolSources('<a href="/index.aspx?path=mbball">Basketball</a><a href="/index.aspx?path=wbball">Basketball</a>', school);
  assert.equal(result.sports.basketball.homeUrl, 'https://sports.example.edu/index.aspx?path=mbball');
  assert.equal(result.sports['womens-basketball'].homeUrl, 'https://sports.example.edu/index.aspx?path=wbball');
});
test('singular sport URLs and parenthetical gender labels work without guessing URLs', () => {
  const result = discoverSchoolSources('<a href="/sport/m-baskbl/">Basketball (M)</a><a href="/sport/w-baskbl/">Basketball (W)</a>', school);
  assert.deepEqual(result.sports.basketball.routes, ['/sport/m-baskbl']);
  assert.deepEqual(result.sports['womens-basketball'].routes, ['/sport/w-baskbl']);
});
test('a nested mens landing route cannot become a shared sport prefix', () => {
  const result = discoverSchoolSources('<a href="/sports/mens/baseball">Baseball</a><a href="/sports/baseball/news">News for Baseball</a><a href="/sports/mens/basketball">Basketball</a>', { ...school, sports: [...school.sports, { slug: 'baseball', name: 'Baseball', gender: 'men' }] });
  assert.deepEqual(result.sports.baseball.routes, ['/sports/baseball']);
  assert.equal(result.sports.baseball.newsUrl, 'https://sports.example.edu/sports/baseball/news');
});
test('only an explicit same-origin entrance is followed from a splash page', () => {
  assert.equal(discoverEntrance('<a href="/index.aspx">Continue to Home</a>', school.athleticsUrl), 'https://sports.example.edu/index.aspx');
  assert.equal(discoverEntrance('<a href="https://attacker.example/">Continue to Home</a>', school.athleticsUrl), null);
});
test('reviewed hostname override is bound to canonical school identity', () => {
  const canonical = { slug: 'binghamton-university', ncaaId: 62, athleticsUrl: 'https://www.bubearcats.com/' };
  assert.ok(sourcePolicy(canonical).allowedHosts.some(host => host === 'binghamtonbearcats.com'));
  assert.throws(() => sourcePolicy({ ...canonical, ncaaId: 1 }), /identity mismatch/);
});
test('explicit lightweight navigation cannot be assigned to heavyweight crew from generic route', () => {
  const heavy = { slug: 'mens-crew', name: 'Crew', gender: 'men' }, light = { slug: 'mens-lightweight-crew', name: 'Lightweight Crew', gender: 'men' };
  const result = discoverSchoolSources('<a href="/sports/mens-rowing">Men\'s Rowing - Lightweight</a><a href="/sports/rowing">Men\'s Heavyweight Rowing</a>', { ...school, sports: [heavy, light] });
  assert.equal(result.sports['mens-crew'].homeUrl, 'https://sports.example.edu/sports/rowing');
  assert.equal(result.sports['mens-lightweight-crew'].homeUrl, 'https://sports.example.edu/sports/mens-rowing');
});
test('reviewed shared archive supplies retrieval URL without inventing sport scope', () => {
  const canonical = { slug: 'university-of-pittsburgh', ncaaId: 545, athleticsUrl: 'https://www.pittsburghpanthers.com/', sports: [men, women] };
  const result = discoverSchoolSources('<main><a href="/archives">View more stories in Story Archives</a></main>', canonical);
  for (const sport of canonical.sports) {
    assert.equal(result.sports[sport.slug].newsUrl, 'https://www.pittsburghpanthers.com/archives');
    assert.equal(result.sports[sport.slug].homeUrl, null);
    assert.equal(result.sports[sport.slug].discoveryStatus, 'reviewed-shared-news-source');
    assert.deepEqual(result.sports[sport.slug].routes, []);
    assert.deepEqual(result.sports[sport.slug].aliases, []);
  }
});
test('unreviewed school homepage does not silently become a shared archive', () => {
  const result = discoverSchoolSources('<main><a href="/archives">All news</a></main>', school);
  assert.equal(result.sports.basketball.newsUrl, null);
});
test('reviewed feature-page entrance remains bound to its canonical school', () => {
  const canonical = { slug: 'college-of-the-holy-cross', ncaaId: 285, athleticsUrl: 'https://goholycross.com/' };
  assert.equal(sourcePolicy(canonical).athleticsUrl, 'https://goholycross.com/sports/2024/9/12/fb-guide.aspx');
  assert.throws(() => sourcePolicy({ ...canonical, athleticsUrl: 'https://attacker.example/' }), /identity mismatch/);
});
test('official (I)/(O) track menu suffixes map only the corresponding season', () => {
  const html = '<a href="/sports/track-and-field">Track &amp; Field (I)</a><a href="/sports/track-and-field">Track &amp; Field (O)</a><a href="/sports/track-and-field/archives">News</a>';
  const result = discoverSchoolSources(html, school);
  for (const sport of track) {
    const source = result.sports[sport.slug];
    assert.equal(source.newsUrl, 'https://sports.example.edu/sports/track-and-field/archives');
    assert.deepEqual(source.aliases, [sport.slug.endsWith('indoor') ? 'Track & Field (I)' : 'Track & Field (O)']);
  }
  assert.equal(result.sports.basketball.newsUrl, null);
  assert.equal(matchNavigationSport("Women's Track & Field (I)", track.find(s => s.slug === 'mens-track-indoor'), school.sports), false);
  assert.equal(matchNavigationSport('Basketball (I)', men, school.sports), false);
});

test('explicit full basketball route and trailing gender labels preserve gender', () => {
  const result = discoverSchoolSources('<a href="/sports/w-basketball/">Basketball</a><a href="/sports/mb/">Basketball - Men\'s</a>', school);
  assert.equal(result.sports['womens-basketball'].homeUrl, 'https://sports.example.edu/sports/w-basketball/');
  assert.equal(result.sports.basketball.homeUrl, 'https://sports.example.edu/sports/mb/');
  assert.equal(matchSport("Basketball - Women's", men), false);
  assert.equal(matchSport("Basketball - Men's", women), false);
  assert.equal(matchSport('w-basketball', men), false);
});

test('observed combined track and cross-country labels scope only those families', () => {
  const xc = ['men', 'women'].map(gender => ({ slug: `${gender}s-cross-country`, name: 'Cross Country', gender }));
  const sponsored = [...school.sports, ...xc];
  for (const label of ['Track & Field, XC', 'Cross Country/Track', 'Cross Country & Track']) {
    const result = discoverSchoolSources(`<a href="/sports/xctrack">${label}</a><a href="/sports/xctrack/archives">News</a>`, { ...school, sports: sponsored });
    for (const sport of [...track, ...xc]) assert.equal(result.sports[sport.slug].newsUrl, 'https://sports.example.edu/sports/xctrack/archives');
    assert.equal(result.sports.basketball.newsUrl, null);
    assert.equal(matchNavigationSport(`Women's ${label}`, xc[0], sponsored), false);
    assert.equal(matchNavigationSport(`Women's ${label}`, xc[1], sponsored), true);
    assert.equal(matchNavigationSport(`${label} Championships`, xc[0], sponsored), false);
  }
});

test('short Track and gendered Swim navigation remain scoped and reject opposite-gender routes', () => {
  const swim = ['men', 'women'].map(gender => ({ slug: `${gender}s-swimming-and-diving`, name: 'Swimming and Diving', gender }));
  const sponsored = [...school.sports, ...swim];
  const result = discoverSchoolSources('<a href="/sports/track-and-field">Track</a><a href="/sports/womens-swim">Women\'s Swim</a><a href="/sports/mens-swimming-and-diving">Swimming</a>', { ...school, sports: sponsored });
  for (const sport of track) assert.equal(result.sports[sport.slug].newsUrl, 'https://sports.example.edu/sports/track-and-field');
  assert.equal(result.sports['womens-swimming-and-diving'].newsUrl, 'https://sports.example.edu/sports/womens-swim');
  assert.equal(result.sports['mens-swimming-and-diving'].newsUrl, 'https://sports.example.edu/sports/mens-swimming-and-diving');
  const genderedRoute = discoverSchoolSources('<a href="/sports/mens-track-and-field">Track and Field</a><a href="/sports/mens-swimming-and-diving">Swimming</a>', { ...school, sports: sponsored });
  assert.equal(genderedRoute.sports['womens-track-indoor'].newsUrl, null);
  assert.equal(genderedRoute.sports['womens-swimming-and-diving'].newsUrl, null);
});
