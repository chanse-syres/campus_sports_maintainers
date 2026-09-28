import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { maintainSchool } from '../src/maintainer.mjs';
import { resolveProvider } from '../src/providers.mjs';
import { newsFeedDefinitions } from '../src/adapters/web-news.mjs';
import { SourceError } from '../src/network.mjs';

const now = '2026-09-27T20:00:00.000Z';
const schools = [
  { slug: 'central-connecticut-state-university', origin: 'https://www.ccsubluedevils.com' },
  { slug: 'tennessee-technological-university', origin: 'https://www.ttusports.com' },
];
const rssUrl = school => `${school.origin}/sports/fball/headlines-featured?feed=rss_2.0`;
const rss = items => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Football news</title>${items}</channel></rss>`;
const item = ({ title, url, date, image, category }) => `<item><title>${title}</title><link>${url}</link>`
  + (date === undefined ? '' : `<pubDate>${date}</pubDate>`)
  + (image ? `<enclosure url="${image}" type="image/jpeg"/>` : '')
  + (category ? `<category>${category}</category>` : '') + '</item>';

async function refresh(school, response) {
  const canonical = await getSchool(school.slug), provider = resolveProvider(canonical, 'football');
  const calls = [], feeds = new Map(newsFeedDefinitions().map(feed => [feed.url, feed]));
  const snapshot = await maintainSchool(school.slug, {
    sport: 'football', now, metadataBudget: 0,
    get: async url => {
      calls.push(url);
      if (url === rssUrl(school)) return typeof response === 'function' ? response() : response;
      if (url === provider.news?.sourceUrl) return JSON.stringify({ header: provider.news.header, link: { href: provider.news.leagueIndexUrl }, articles: [] });
      const feed = feeds.get(url);
      if (feed) return `<rss version="2.0"><channel><title>${feed.feedTitle.replaceAll('&', '&amp;')}</title></channel></rss>`;
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  });
  // A swallowed fallback failure must still fail the test. Only the reviewed
  // RSS may be requested from this school's host, even when it is denied.
  assert.deepEqual(calls.filter(url => new URL(url).hostname === new URL(school.origin).hostname), [rssUrl(school)]);
  assert.deepEqual(Object.keys(snapshot.sports), ['football']);
  const news = snapshot.sports.football.news;
  const health = news.sources.find(source => source.sourceUrl === rssUrl(school));
  assert.ok(health, 'RSS must retain its own source-health record');
  assert.equal(news.sourceUrl, rssUrl(school));
  return { news, health };
}

for (const school of schools) {
  test(`${school.slug} reads reviewed RSS and keeps only same-school football stories`, async () => {
    const url = `${school.origin}/sports/fball/2026-27/releases/20260926fixture`;
    const image = `${school.origin}/sports/fball/photos/team.jpg`;
    const { news, health } = await refresh(school, rss([
      item({ title: 'Football wins on the road', url, date: 'Sat, 26 Sep 2026 12:30:00 GMT', image }),
      item({ title: 'Baseball announces schedule', url: `${school.origin}/sports/bsb/2026-27/releases/baseball`, date: 'Sat, 26 Sep 2026 12:30:00 GMT', category: 'Baseball' }),
      item({ title: 'Another school football story', url: 'https://other.example/sports/fball/releases/foreign', date: 'Sat, 26 Sep 2026 12:30:00 GMT', category: 'Football' }),
      item({ title: 'Unscoped campus update', url: `${school.origin}/news/campus-update`, date: 'Sat, 26 Sep 2026 12:30:00 GMT' }),
    ].join('')));
    assert.equal(news.status, 'ok');
    assert.equal(health.status, 'ok');
    assert.equal(health.recordCount, 1);
    assert.equal(health.lastSuccessAt, now);
    assert.equal(news.records.length, 1);
    assert.equal(news.records[0].url, url);
    assert.equal(news.records[0].publishedAt, '2026-09-26T12:30:00.000Z');
    assert.equal(news.records[0].publishedAtPrecision, 'instant');
    assert.equal(news.records[0].imageUrl, image);
    assert.equal(news.records[0].discoverySourceUrl, rssUrl(school));
  });

  test(`${school.slug} never substitutes the refresh time for missing or invalid RSS dates`, async () => {
    const { news } = await refresh(school, rss([
      item({ title: 'Undated football announcement', url: `${school.origin}/sports/fball/releases/undated` }),
      item({ title: 'Football announcement with invalid date', url: `${school.origin}/sports/fball/releases/invalid-date`, date: 'not a publication date' }),
    ].join('')));
    assert.equal(news.status, 'ok');
    assert.equal(news.records.length, 2);
    for (const record of news.records) {
      assert.equal(record.publishedAt, null);
      assert.equal(record.publishedAtPrecision, 'unknown');
    }
  });

  test(`${school.slug} denied RSS remains unavailable without requesting an HTML fallback`, async () => {
    const { news, health } = await refresh(school, () => { throw new SourceError('http-405'); });
    assert.equal(health.status, 'unavailable');
    assert.equal(health.reason, 'http-405');
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.recordCount, 0);
    assert.deepEqual(news.records, []);
  });

  test(`${school.slug} malformed RSS remains unavailable without requesting an HTML fallback`, async () => {
    const { news, health } = await refresh(school, '<rss><channel><item><title>Truncated football feed');
    assert.equal(health.status, 'unavailable');
    assert.equal(health.reason, 'source-format-changed');
    assert.equal(health.lastSuccessAt, null);
    assert.equal(health.recordCount, 0);
    assert.deepEqual(news.records, []);
  });
}
