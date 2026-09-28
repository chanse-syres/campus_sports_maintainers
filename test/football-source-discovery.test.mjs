import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSchoolSources } from '../src/discovery.mjs';
import { getSchool } from '../src/config.mjs';
import { maintainSchool } from '../src/maintainer.mjs';
import { resolveProvider } from '../src/providers.mjs';
import { newsFeedDefinitions } from '../src/adapters/web-news.mjs';
import { SourceError } from '../src/network.mjs';

const football = { slug: 'football', name: 'Football', code: 'MFB', gender: 'men' };
const baseball = { slug: 'baseball', name: 'Baseball', code: 'MBA', gender: 'men' };
const school = { athleticsUrl: 'https://sports.example.edu/', sports: [football, baseball] };

test('placeholder News navigation cannot select the current schedule as a news collection', () => {
  for (const href of ['#', '#news', '', '  #news  ']) {
    const html = `<a href="${href}" aria-label="News">News</a>`
      + '<a href="/sports/fball/index">Football</a>'
      + '<a href="/sports/fball/headlines-featured">News</a>';
    const source = discoverSchoolSources(html, school, 'https://sports.example.edu/sports/fball/2025-26/schedule').sports.football;
    assert.equal(source.homeUrl, 'https://sports.example.edu/sports/fball/index');
    assert.equal(source.newsUrl, 'https://sports.example.edu/sports/fball/headlines-featured');
  }
});

const soconSource = 'https://soconsports.com/fb/';
const soconArticle = 'https://soconsports.com/fb/article/60372/';
const soconImage = 'https://img.boostsport.ai/boost-cms/tennessee-tech-football.jpg';
const soconFixture = '<a href="/fb/article/60372/">Tennessee Tech football weekly honors</a>'
  + `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
    params: { sport: 'fb' }, fallback: { 'contentTypeUid:"article",': [{
      id: 60372, _content_type_uid: 'article', _status: 'published', _in_progress: false,
      simple_headline: 'Tennessee Tech football weekly honors', publish_date: '2026-09-14T19:00:00.000Z',
      image: { url: soconImage }, sport: [{ id: 31, alias: 'fb', title: 'Football' }],
      school: [{ id: 884, alias: 'TTU', title: 'Tennessee Tech' }],
    }] },
  } } })}</script>`;

async function refreshTennesseeTechFootball(response) {
  const slug = 'tennessee-technological-university';
  const canonical = await getSchool(slug), provider = resolveProvider(canonical, 'football');
  const calls = [], feeds = new Map(newsFeedDefinitions().map(feed => [feed.url, feed]));
  const snapshot = await maintainSchool(slug, { sport: 'football', now: '2026-09-18T00:00:00.000Z', metadataBudget: 0, get: async url => {
    calls.push(url);
    if (url === soconSource) return typeof response === 'function' ? response() : response;
    if (url === provider.news?.sourceUrl) return JSON.stringify({ header: provider.news.header, link: { href: provider.news.leagueIndexUrl }, articles: [] });
    const feed = feeds.get(url);
    if (feed) return `<rss version="2.0"><channel><title>${feed.feedTitle.replaceAll('&', '&amp;')}</title></channel></rss>`;
    throw new Error(`Unexpected fixture request: ${url}`);
  } });
  // Source failures become dataset state, so inspect calls explicitly: an
  // attempted blocked-athletics fallback must not be hidden by a caught error.
  assert.equal(calls.some(url => ['ttusports.com', 'www.ttusports.com'].includes(new URL(url).hostname)), false);
  assert.deepEqual(calls.filter(url => new URL(url).hostname === 'soconsports.com'), [soconSource]);
  assert.deepEqual(Object.keys(snapshot.sports), ['football']);
  const news = snapshot.sports.football.news;
  assert.equal(news.sourceUrl, soconSource);
  return { news, provider, health: news.sources.find(source => source.sourceUrl === soconSource) };
}

test('Tennessee Tech football reads reviewed SoCon news without requesting blocked athletics pages', async () => {
  const { news, health } = await refreshTennesseeTechFootball(soconFixture);
  assert.equal(news.status, 'ok');
  assert.equal(news.records.length, 1);
  assert.equal(news.records[0].url, soconArticle);
  assert.equal(news.records[0].publisher, 'The Southern Conference');
  assert.equal(news.records[0].discoverySourceUrl, soconSource);
  assert.equal(news.records[0].publishedAt, '2026-09-14T19:00:00.000Z');
  assert.equal(news.records[0].publishedAtPrecision, 'instant');
  assert.equal(news.records[0].imageUrl, soconImage);
  assert.equal(health.status, 'ok');
  assert.equal(health.recordCount, 1);
  assert.equal(health.lastSuccessAt, '2026-09-18T00:00:00.000Z');
});

test('denied SoCon news stays degraded despite successful empty ESPN and supplemental feeds', async () => {
  const { news, health, provider } = await refreshTennesseeTechFootball(() => { throw new SourceError('http-405'); });
  assert.ok(['unavailable', 'stale'].includes(news.status), news.status);
  assert.equal(news.reason, 'one-or-more-news-sources-degraded');
  assert.deepEqual(news.records, []);
  assert.equal(health.status, 'unavailable');
  assert.equal(health.reason, 'http-405');
  assert.equal(health.lastSuccessAt, null);
  assert.equal(health.recordCount, 0);
  assert.equal(news.sources.find(source => source.sourceUrl === provider.news.sourceUrl).status, 'empty');
});

test('legacy football home preserves observed modern football collection links', () => {
  const html = '<a href="/index.aspx?path=fb">Football</a>'
    + '<a href="/sports/football/schedule">Football: Schedule</a>'
    + '<a href="/sports/football/roster">Football: Roster</a>'
    + '<a href="/sports/football/archives">Football: News</a>';
  const source = discoverSchoolSources(html, school).sports.football;
  assert.equal(source.homeUrl, 'https://sports.example.edu/index.aspx?path=fb');
  assert.equal(source.newsUrl, 'https://sports.example.edu/sports/football/archives');
  assert.equal(source.rosterUrl, 'https://sports.example.edu/sports/football/roster');
  assert.equal(source.scheduleUrl, 'https://sports.example.edu/sports/football/schedule');
});

test('a legacy football home does not adopt another sport, article, or external archive', () => {
  const html = '<a href="/index.aspx?path=fb">Football</a>'
    + '<a href="/sports/baseball/archives">Football: News</a>'
    + '<a href="/news/2026/9/17/football-weekly-notes.aspx">Football: News</a>'
    + '<a href="https://other.example/sports/football/archives">Football: News</a>';
  const source = discoverSchoolSources(html, school).sports.football;
  assert.equal(source.newsUrl, 'https://sports.example.edu/index.aspx?path=fb');
  assert.equal(source.rosterUrl, null);
  assert.equal(source.scheduleUrl, null);
});

test('modern collection links cannot override an explicit opposite-gender route', () => {
  const men = { slug: 'basketball', name: "Men's Basketball", code: 'MBB', gender: 'men' };
  const women = { slug: 'womens-basketball', name: "Women's Basketball", code: 'WBB', gender: 'women' };
  const html = '<a href="/index.aspx?path=mbball">Men\'s Basketball</a>'
    + '<a href="/sports/womens-basketball/archives">Men\'s Basketball: News</a>';
  const source = discoverSchoolSources(html, { ...school, sports: [men, women] }).sports.basketball;
  assert.equal(source.newsUrl, 'https://sports.example.edu/index.aspx?path=mbball');
});
