import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources, discoverEntrance, sourcePolicy } from '../src/discovery.mjs';
import { matchSport, matchNavigationSport } from '../src/sports.mjs';
const men = { slug: 'basketball', name: 'Basketball', code: 'MBB', gender: 'men' };
const women = { slug: 'womens-basketball', name: 'Basketball', code: 'WBB', gender: 'women' };
const track = ['men', 'women'].flatMap(gender => ['indoor', 'outdoor'].map(season => ({ slug: `${gender}s-track-${season}`, name: `${season} Track`, gender })));
const school = { athleticsUrl: 'https://sports.example.edu/', sports: [men, women, ...track] };

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
  assert.ok(sourcePolicy(canonical).allowedHosts.includes('binghamtonbearcats.com'));
  assert.throws(() => sourcePolicy({ ...canonical, ncaaId: 1 }), /identity mismatch/);
});
test('explicit lightweight navigation cannot be assigned to heavyweight crew from generic route', () => {
  const heavy = { slug: 'mens-crew', name: 'Crew', gender: 'men' }, light = { slug: 'mens-lightweight-crew', name: 'Lightweight Crew', gender: 'men' };
  const result = discoverSchoolSources('<a href="/sports/mens-rowing">Men\'s Rowing - Lightweight</a><a href="/sports/rowing">Men\'s Heavyweight Rowing</a>', { ...school, sports: [heavy, light] });
  assert.equal(result.sports['mens-crew'].homeUrl, 'https://sports.example.edu/sports/rowing');
  assert.equal(result.sports['mens-lightweight-crew'].homeUrl, 'https://sports.example.edu/sports/mens-rowing');
});
