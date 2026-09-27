import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialNews } from '../src/adapters/official.mjs';
import { discoverSchoolSources } from '../src/discovery.mjs';
import { getSchool } from '../src/config.mjs';
const story = (extra = {}) => ({ story_headline: 'A new season', story_path: '/news/2026/9/16/a-new-season', story_postdate: '9/16/2026', story_image: '/images/team.jpg', sport_title: "Men's Basketball", ...extra });
const script = stories => '<script>var obj = ' + JSON.stringify({ type: 'stories', data: stories }) + ';</script>';

test('Texas combined feed needs observed navigation and rejects explicit opposite-gender story metadata', async () => {
  const texas = await getSchool('university-of-texas-at-austin');
  const sources = discoverSchoolSources('<a href="/sports/track-and-field">Track &amp; Field/Cross Country</a>', texas).sports;
  const html = script([
    story({ story_headline: 'Combined program news', sport_title: 'Track & Field / Cross Country', story_path: '/news/2026/9/16/shared-program-news' }),
    story({ story_headline: 'Men program news', sport_title: "Men's Cross Country", story_path: '/news/2026/9/16/track-and-field-mens-news' }),
    story({ story_headline: 'Women program news', sport_title: "Women's Cross Country", story_path: '/news/2026/9/16/track-and-field-womens-news' }),
    story({ story_headline: 'Different sport', sport_title: 'Baseball', story_path: '/news/2026/9/16/baseball-news' }),
  ]);
  for (const gender of ['mens', 'womens']) {
    const canonical = texas.sports.find(sport => sport.slug === `${gender}-cross-country`);
    const scoped = { ...canonical, ...sources[canonical.slug] };
    const records = parseOfficialNews(html, sources[canonical.slug].newsUrl, texas, scoped).records;
    assert.deepEqual(records.map(record => record.title), ['Combined program news', gender === 'mens' ? 'Men program news' : 'Women program news']);
    const onlyCombined = script([story({ sport_title: 'Track & Field / Cross Country', story_path: '/news/2026/9/16/shared-program-news' })]);
    assert.throws(() => parseOfficialNews(onlyCombined, sources[canonical.slug].newsUrl, texas, canonical), /No recognizable/);
  }
});