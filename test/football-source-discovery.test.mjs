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

test('Tennessee Tech football reads the reviewed news archive without requesting the denied old schedule', async () => {
  const slug = 'tennessee-technological-university';
  const canonical = await getSchool(slug), provider = resolveProvider(canonical, 'football');
  const archive = 'https://www.ttusports.com/sports/fball/headlines-featured';
  const oldSchedule = 'https://www.ttusports.com/sports/fball/2025-26/schedule';
  const calls = [], feeds = new Map(newsFeedDefinitions().map(feed => [feed.url, feed]));
  const snapshot = await maintainSchool(slug, { sport: 'football', now: '2026-09-18T00:00:00.000Z', metadataBudget: 0, get: async url => {
    calls.push(url);
    if (url === oldSchedule) throw new SourceError('http-405');
    if (url === archive) return '<div class="card"><div class="entry-title"><a href="/sports/fball/2026-27/releases/20260914fixture">Tennessee Tech football weekly honors</a></div><div class="entry-category">Football</div><span class="date">September 14, 2026</span><img src="/sports/fball/photos/team.jpg"></div>';
    if (url === provider.news?.sourceUrl) return JSON.stringify({ header: provider.news.header, link: { href: provider.news.leagueIndexUrl }, articles: [] });
    const feed = feeds.get(url);
    if (feed) return `<rss version="2.0"><channel><title>${feed.feedTitle.replaceAll('&', '&amp;')}</title></channel></rss>`;
    throw new Error(`Unexpected fixture request: ${url}`);
  } });
  assert.equal(calls.some(url => url === oldSchedule), false);
  assert.equal(calls.filter(url => url === archive).length, 1);
  const news = snapshot.sports.football.news;
  assert.equal(news.status, 'ok');
  assert.equal(news.sourceUrl, archive);
  assert.equal(news.records.length, 1);
  assert.equal(news.records[0].discoverySourceUrl, archive);
  assert.equal(news.records[0].publishedAt, '2026-09-14T00:00:00.000Z');
  assert.equal(news.records[0].imageUrl, 'https://www.ttusports.com/sports/fball/photos/team.jpg');
  assert.equal(news.sources.find(source => source.sourceUrl === archive).status, 'ok');
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
