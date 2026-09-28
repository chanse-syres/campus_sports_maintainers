import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources, discoverEntrance, enrichSportSources, sourcePolicy, reviewedSportNewsUrl } from '../src/discovery.mjs';
import { getSchool } from '../src/config.mjs';
import { matchSport, matchNavigationSport } from '../src/sports.mjs';
const men = { slug: 'basketball', name: 'Basketball', code: 'MBB', gender: 'men' };
const women = { slug: 'womens-basketball', name: 'Basketball', code: 'WBB', gender: 'women' };
const track = ['men', 'women'].flatMap(gender => ['indoor', 'outdoor'].map(season => ({ slug: `${gender}s-track-${season}`, name: `${season} Track`, gender })));
const school = { athleticsUrl: 'https://sports.example.edu/', sports: [men, women, ...track] };

test('reviewed sport archives replace empty shared collections without manufacturing program navigation', async () => {
  const targets = [
    ['central-connecticut-state-university', { football: 'https://www.ccsubluedevils.com/sports/fball/headlines-featured?feed=rss_2.0' }],
    ['arkansas-state-university', { football: 'https://www.astateredwolves.com/sports/football/archives' }],
    ['idaho-state-university', { 'womens-basketball': 'https://www.isubengals.com/sports/womens-basketball/archives' }],
    ['tennessee-technological-university', { baseball: 'https://www.ttusports.com/sports/bsb/headlines-featured', basketball: 'https://www.ttusports.com/sports/mbkb/headlines-featured', football: 'https://www.ttusports.com/sports/fball/headlines-featured?feed=rss_2.0', 'womens-basketball': 'https://www.ttusports.com/sports/wbkb/headlines-featured' }],
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

test('reviewed RSS URLs keep exact host, sport, collection and query restrictions', () => {
  const sport = { slug: 'football', name: 'Football', gender: 'men', code: 'MFB' };
  const base = 'https://sports.example.edu/sports/fball/headlines-featured';
  const hosts = ['sports.example.edu'];
  assert.equal(reviewedSportNewsUrl(base, sport, hosts), base);
  assert.equal(reviewedSportNewsUrl(`${base}?feed=rss_2.0`, sport, hosts), `${base}?feed=rss_2.0`);
  for (const url of [
    `${base}?feed=rss_2.0&url=https://other.example/`, `${base}?feed=rss_2.0&feed=rss_2.0`,
    `${base}?feed=xml`, `${base}?page=2`, `${base}?feed=rss_2.0#fragment`,
    'https://other.example/sports/fball/headlines-featured?feed=rss_2.0',
    'https://sports.example.edu/sports/wbkb/headlines-featured?feed=rss_2.0',
    'https://sports.example.edu/sports/fball/roster?feed=rss_2.0',
    'https://sports.example.edu/sports/fball/2026-27/releases/story?feed=rss_2.0',
  ]) assert.equal(reviewedSportNewsUrl(url, sport, hosts), null, url);
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
  for (const label of ['Track & Field, XC', 'Track & Field/Cross Country', 'Track & Field / Cross Country', 'Cross Country/Track', 'Cross Country & Track', 'XC/Track & Field', 'XC / Track', 'Cross Country / Track & Field', 'Track/Cross Country', 'Cross Country & Track & Field']) {
    const result = discoverSchoolSources(`<a href="/sports/xctrack">${label}</a><a href="/sports/xctrack/archives">News</a>`, { ...school, sports: sponsored });
    for (const sport of [...track, ...xc]) assert.equal(result.sports[sport.slug].newsUrl, 'https://sports.example.edu/sports/xctrack/archives');
    assert.equal(result.sports.basketball.newsUrl, null);
    assert.equal(matchNavigationSport(`Women's ${label}`, xc[0], sponsored), false);
    assert.equal(matchNavigationSport(`Women's ${label}`, xc[1], sponsored), true);
    assert.equal(matchNavigationSport(`${label} Championships`, xc[0], sponsored), false);
  }
});

test('combined XC/track menus can reuse the same-gender route, never the opposite-gender route', () => {
  const xc = ['men', 'women'].map(gender => ({ slug: `${gender}s-cross-country`, name: 'Cross Country', gender }));
  const sponsored = [...school.sports, ...xc];
  for (const [mens, womens] of [['mens-cross-country', 'womens-cross-country'], ['mxct', 'womens-cross-country-track']]) {
    const html = `<a href="/sports/${mens}">Cross Country/Track</a><a href="/sports/${womens}">Cross Country/Track</a>`;
    const result = discoverSchoolSources(html, { ...school, sports: sponsored });
    for (const sport of [...track, ...xc]) assert.equal(result.sports[sport.slug].homeUrl, `https://sports.example.edu/sports/${sport.gender === 'men' ? mens : womens}`);
    assert.equal(result.sports.basketball.homeUrl, null);
  }
  const onlyCross = discoverSchoolSources('<a href="/sports/mens-cross-country">Cross Country</a>', { ...school, sports: sponsored });
  assert.equal(onlyCross.sports['mens-track-indoor'].newsUrl, null);
  const conflicting = discoverSchoolSources('<a href="/sports/mens-basketball">Cross Country/Track</a>', { ...school, sports: sponsored });
  for (const sport of [...track, ...xc]) assert.equal(conflicting.sports[sport.slug].newsUrl, null);
  for (const token of ['mitf', 'motf', 'witf', 'wotf']) {
    const shortRoute = discoverSchoolSources(`<a href="/sports/${token}">Cross Country/Track</a>`, { ...school, sports: sponsored });
    for (const sport of [...track, ...xc]) assert.equal(Boolean(shortRoute.sports[sport.slug].newsUrl), sport.gender === (token.startsWith('w') ? 'women' : 'men') && (!sport.slug.includes('-track-') || sport.slug.endsWith(token[1] === 'i' ? 'indoor' : 'outdoor')));
  }
});

test('complete season labels preserve indoor/outdoor and explicit gender', () => {
  for (const label of ['Track & Field (Indoor)', 'Track & Field - Indoor', 'Indoor Track & Field']) {
    const result = discoverSchoolSources(`<a href="/sports/track-and-field">${label}</a>`, school);
    for (const sport of track) assert.equal(Boolean(result.sports[sport.slug].newsUrl), sport.slug.endsWith('indoor'));
    for (const sport of track) assert.equal(matchNavigationSport(`Women's ${label}`, sport, school.sports), sport.gender === 'women' && sport.slug.endsWith('indoor'));
  }
  const sportsPrefix = discoverSchoolSources('<a href="/sports/track-and-field">Women\'s Sports Track &amp; Field</a>', school);
  assert.equal(sportsPrefix.sports['mens-track-indoor'].newsUrl, null);
  assert.ok(sportsPrefix.sports['womens-track-indoor'].newsUrl);
});

test('observed swim/dive, water-polo and artistic-swimming labels keep gender and family scope', () => {
  const swimming = ['men', 'women'].map(gender => ({ slug: `${gender}s-swimming-and-diving`, name: 'Swimming and Diving', gender }));
  const polo = ['men', 'women'].map(gender => ({ slug: `${gender}s-water-polo`, name: 'Water Polo', gender }));
  const artistic = { slug: 'womens-synchronized-swimming', name: 'Synchronized Swimming', gender: 'women' };
  const result = discoverSchoolSources('<a href="/sports/mens-swim-dive">Swim &amp; Dive</a><a href="/sports/womens-swim-dive">Swim &amp; Dive</a><a href="/index.aspx?path=mwpolo">Water Polo</a><a href="/index.aspx?path=wwpolo">Water Polo</a><a href="/sports/artistic-swimming">Artistic Swimming</a>', { ...school, sports: [...school.sports, ...swimming, ...polo, artistic] });
  for (const sport of swimming) assert.equal(result.sports[sport.slug].homeUrl, `https://sports.example.edu/sports/${sport.gender}s-swim-dive`);
  for (const sport of polo) assert.equal(result.sports[sport.slug].homeUrl, `https://sports.example.edu/index.aspx?path=${sport.gender === 'men' ? 'm' : 'w'}wpolo`);
  assert.equal(result.sports[artistic.slug].homeUrl, 'https://sports.example.edu/sports/artistic-swimming');
  assert.equal(result.sports.basketball.homeUrl, null);
});

test('a semantic gender heading can disambiguate wrestling while a generic link remains ambiguous', () => {
  const wrestling = ['men', 'women'].map(gender => ({ slug: `${gender}s-wrestling`, name: 'Wrestling', gender }));
  const configured = { ...school, sports: wrestling };
  const result = discoverSchoolSources('<ul><li><h3>Men\'s Sports</h3><ul><li><a href="/sports/wrestling">Wrestling</a></li></ul></li></ul>', configured);
  assert.equal(result.sports['mens-wrestling'].homeUrl, 'https://sports.example.edu/sports/wrestling');
  assert.equal(result.sports['womens-wrestling'].homeUrl, null);
  const generic = discoverSchoolSources('<a href="/sports/wrestling">Wrestling</a>', configured);
  assert.equal(generic.sports['mens-wrestling'].homeUrl, null);
  assert.equal(generic.sports['womens-wrestling'].homeUrl, null);
});

test('Texas combined navigation maps the six sponsored programs without expanding other sports or gendered routes', async () => {
  const texas = await getSchool('university-of-texas-at-austin');
  const html = '<a href="/sports/track-and-field">Track &amp; Field/Cross Country</a>';
  const discovered = discoverSchoolSources(html, texas);
  const expected = ['mens-cross-country', 'womens-cross-country', 'mens-track-indoor', 'mens-track-outdoor', 'womens-track-indoor', 'womens-track-outdoor'];
  assert.deepEqual(Object.entries(discovered.sports).filter(([, source]) => source.newsUrl).map(([slug]) => slug).sort(), expected.sort());
  for (const slug of expected) {
    assert.equal(discovered.sports[slug].newsUrl, 'https://www.texaslonghorns.com/sports/track-and-field');
    assert.deepEqual(discovered.sports[slug].routes, ['/sports/track-and-field']);
    assert.deepEqual(discovered.sports[slug].aliases, ['Track & Field/Cross Country']);
  }
  const gendered = discoverSchoolSources(html.replace('/sports/track-and-field', '/sports/mens-track-and-field'), texas);
  for (const slug of expected.filter(slug => slug.startsWith('womens-'))) assert.equal(gendered.sports[slug].newsUrl, null);
  const plainTrack = discoverSchoolSources(html.replace('Track &amp; Field/Cross Country', 'Track &amp; Field'), texas);
  assert.equal(plainTrack.sports['mens-cross-country'].newsUrl, null);
  assert.equal(plainTrack.sports['womens-cross-country'].newsUrl, null);
  for (const token of ['mcc', 'mti', 'mto', 'wcc', 'wti', 'wto']) {
    const codeRoute = discoverSchoolSources(html.replace('/sports/track-and-field', `/sports/${token}`), texas);
    for (const sport of texas.sports.filter(item => expected.includes(item.slug))) {
      const season = token.endsWith('ti') ? 'indoor' : token.endsWith('to') ? 'outdoor' : null;
      const matches = sport.gender === (token.startsWith('w') ? 'women' : 'men') && (!season || !sport.slug.includes('-track-') || sport.slug.endsWith(season));
      assert.equal(Boolean(codeRoute.sports[sport.slug].newsUrl), matches);
    }
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
