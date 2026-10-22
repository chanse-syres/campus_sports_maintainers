import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources, sourcePolicy } from '../src/discovery.mjs';
import { matchNavigationSport, matchSport } from '../src/sports.mjs';
import { getSchool } from '../src/config.mjs';

const golf = ['men', 'women'].map(gender => ({ slug: `${gender}s-golf`, name: 'Golf', gender, code: gender === 'men' ? 'MGO' : 'WGO' }));
const school = { slug: 'fixture-school', ncaaId: 1, athleticsUrl: 'https://sports.example.edu/', sports: golf };
const navigation = data => `<script>var obj = ${JSON.stringify({ type: 'main-navigation', data })}; initialize(obj);</script>`;

test('declared Sidearm navigation preserves gender lost by flattened fallback links', () => {
  const html = navigation([{ title: 'Sports', items: [
    { title: "Men's Sports", items: [{ title: 'Golf', url: '/sports/golf' }] },
    { title: "Women's Sports", items: [{ title: 'Golf', url: '/sports/womens-golf' }] }
  ] }]) + '<div><a href="/sports/golf">Golf</a><a href="/sports/golf/archives">Golf: News</a></div>';
  const result = discoverSchoolSources(html, school);
  assert.equal(result.sports['mens-golf'].newsUrl, 'https://sports.example.edu/sports/golf/archives');
  assert.equal(result.sports['womens-golf'].homeUrl, 'https://sports.example.edu/sports/womens-golf');
  assert.ok(result.sports['mens-golf'].aliases.includes('mens Golf'));
});

test('varsity section headings identify generic wrestling without assigning the other gender', () => {
  const sports = ['men', 'women'].map(gender => ({ slug: `${gender}s-wrestling`, name: 'Wrestling', gender }));
  const html = '<ul><li><span>MEN\'S VARSITY</span></li><li><a href="/sports/wrestling">Wrestling</a></li><li><span>WOMEN\'S VARSITY</span></li><li><a href="/sports/womens-wrestling">Wrestling</a></li></ul>';
  const result = discoverSchoolSources(html, { ...school, sports });
  assert.equal(result.sports['mens-wrestling'].homeUrl, 'https://sports.example.edu/sports/wrestling');
  assert.equal(result.sports['womens-wrestling'].homeUrl, 'https://sports.example.edu/sports/womens-wrestling');
});

test('flat declared navigation keeps gender only within its separator column', () => {
  const html = navigation([{ title: 'Sports', items: [
    { title: "Men's Sports", separator: true, column: 1 },
    { title: 'Golf', url: '/sports/golf', column: 1 },
    { title: "Women's Sports", separator: true, column: 2 },
    { title: 'Golf', url: '/sports/womens-golf', column: 2 },
    { title: 'Other', separator: true, column: 3 },
    { title: 'Golf', url: '/sports/unverified-golf', column: 3 }
  ] }]);
  const result = discoverSchoolSources(html, school);
  assert.equal(result.sports['mens-golf'].homeUrl, 'https://sports.example.edu/sports/golf');
  assert.equal(result.sports['womens-golf'].homeUrl, 'https://sports.example.edu/sports/womens-golf');
  assert.ok(!JSON.stringify(result).includes('unverified-golf'));
});

test('navigation recovery rejects unrelated script data, offsite links and conflicting sport gender', () => {
  const wrongType = '<script>var obj = {"type":"ads","data":[{"title":"Men\'s Sports","items":[{"title":"Golf","url":"/sports/golf"}]}]};</script>';
  assert.equal(discoverSchoolSources(wrongType, school).sports['mens-golf'].homeUrl, null);
  const html = navigation([{ title: "Men's Sports", items: [
    { title: 'Golf', url: 'https://other.example/sports/golf' },
    { title: 'Golf', url: '/sports/womens-golf' }
  ] }]);
  assert.equal(discoverSchoolSources(html, school).sports['mens-golf'].homeUrl, null);
  assert.equal(discoverSchoolSources('<script>var obj = {broken};</script>', school).sports['mens-golf'].homeUrl, null);
});

test('observed open and combined sailing labels preserve the sponsored sailing scope', () => {
  const sailing = [
    { slug: 'coed-sailing', name: 'Sailing', gender: 'mixed' },
    { slug: 'womens-sailing', name: 'Sailing', gender: 'women' }
  ];
  for (const label of ['Sailing - Open', 'Sailing (Coed)']) {
    assert.equal(matchNavigationSport(label, sailing[0], sailing), true);
    assert.equal(matchNavigationSport(label, sailing[1], sailing), false);
  }
  for (const label of ["Men/Women's Sailing", "Sailing - Open & Women's"]) {
    for (const sport of sailing) assert.equal(matchNavigationSport(label, sport, sailing), true);
    assert.equal(matchNavigationSport(label, golf[0], [...sailing, ...golf]), false);
  }
  const acro = { slug: 'womens-acrobatics-and-tumbling', name: 'Acrobatics and Tumbling', gender: 'women' };
  assert.equal(matchSport('Acrobatics', acro), true);
  assert.equal(matchSport('Acrobatics', golf[1]), false);
});

test('reviewed combined Wake Forest archives keep separate requested sport identities', async () => {
  const school = await getSchool('wake-forest-university');
  const policy = sourcePolicy(school);
  assert.equal(policy.sportNewsUrls['mens-cross-country'], 'https://godeacs.com/sports/cross-country/archives');
  assert.equal(policy.sportNewsUrls['womens-cross-country'], 'https://godeacs.com/sports/cross-country/archives');
  assert.equal(policy.sportNewsUrls['womens-track-indoor'], 'https://godeacs.com/sports/track-and-field/archives');
  assert.equal(policy.sportNewsUrls.basketball, 'https://godeacs.com/sports/mens-basketball/archives/');
  const basketball = school.sports.find(sport => sport.slug === 'basketball');
  assert.equal(matchNavigationSport('cross-country', basketball, school.sports), false);
});
