import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool, loadSources } from '../src/config.mjs';
import { discoverSchoolSources, enrichSportSources, sourcePolicy } from '../src/discovery.mjs';
import { matchSport, matchSportRoute, normalizeSportLabel } from '../src/sports.mjs';

const archives = [
  ['texas-southern-university', 'womens-cross-country', '/sports/cross-country-women'],
  ['texas-southern-university', 'womens-track-indoor', '/sports/womens-track-and-field'],
  ['texas-southern-university', 'womens-track-outdoor', '/sports/womens-track-and-field'],
  ['university-of-central-arkansas', 'womens-cross-country', '/sports/womens-cross-country'],
];

test('the complete Texas Southern women XC suffix establishes only the women program', async () => {
  const school = await getSchool('texas-southern-university');
  const women = school.sports.find(sport => sport.slug === 'womens-cross-country');
  const men = school.sports.find(sport => sport.slug === 'mens-cross-country');
  for (const label of ['Cross Country-Women', 'cross-country-women']) {
    assert.equal(normalizeSportLabel(label), 'womens cross country');
    assert.equal(matchSport(label, women), true);
    assert.equal(matchSport(label, men), false);
  }
  assert.equal(matchSportRoute('https://www.tsusports.com/sports/cross-country-women/archives', women), true);
  assert.equal(matchSportRoute('https://www.tsusports.com/sports/cross-country-women/archives', men), false);
  for (const label of ['not-cross-country-women', 'cross-country-women-news', 'basketball-women']) {
    assert.equal(matchSport(label, women), false);
  }
});

test('reviewed women sources preserve explicit program routes and survive discovery/enrichment', async () => {
  const registry = await loadSources();
  for (const [slug, sportSlug, route] of archives) {
    const school = await getSchool(slug), sport = school.sports.find(item => item.slug === sportSlug);
    const policy = sourcePolicy(school), homeUrl = new URL(route, school.athleticsUrl).href;
    const newsUrl = `${homeUrl}/archives`, source = registry.schools[slug].sports[sportSlug];
    assert.equal(source.homeUrl, homeUrl);
    assert.equal(source.newsUrl, newsUrl);
    assert.equal(source.rosterUrl, `${homeUrl}/roster`);
    assert.equal(source.scheduleUrl, `${homeUrl}/schedule`);
    assert.deepEqual(source.routes, [route]);
    assert.equal(policy.sportNewsUrls[sportSlug], newsUrl);

    // These schools expose generic men's program links before women's links.
    // A later discovery or deep-enrichment run must keep the reviewed archive.
    const wrongRoute = sportSlug.includes('cross-country') ? '/sports/cross-country' : '/sports/track-and-field';
    const html = `<a href="${wrongRoute}">${sportSlug.includes('cross-country') ? 'Cross Country' : 'Track and Field'}</a>
      <a href="${wrongRoute}/archives">News</a>`;
    assert.equal(discoverSchoolSources(html, school).sports[sportSlug].newsUrl, newsUrl);
    assert.equal(enrichSportSources(html, school, sport, source, policy.allowedHosts).newsUrl, newsUrl);
  }
});
