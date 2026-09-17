import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialNews, collectOfficialNews } from '../src/adapters/official.mjs';

const school = { slug: 'example', name: 'Example University', athleticsUrl: 'https://athletics.example.edu/' };
const men = { slug: 'basketball', name: "Men's Basketball", gender: 'men', code: 'MBB' };
const women = { slug: 'womens-basketball', name: "Women's Basketball", gender: 'women', code: 'WBB' };
const source = 'https://athletics.example.edu/sports/mens-basketball/archives';
const story = (extra = {}) => ({ story_headline: 'A new season', story_path: '/news/2026/9/16/a-new-season.aspx', story_postdate: '9/16/2026', story_image: '/images/team.jpg', sport_title: "Men's Basketball", ...extra });
const script = stories => `<script>var obj = ${JSON.stringify({ type: 'stories', data: stories })}; window.untrusted = true;</script>`;
function nuxt(nodes) {
  const table = [];
  const add = value => {
    const index = table.length; table.push(null);
    table[index] = Array.isArray(value) ? value.map(add) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, add(val)])) : value;
    return index;
  };
  nodes.forEach(add);
  return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(table)}</script>`;
}

test('classic Sidearm embedded stories preserve metadata, not article bodies', () => {
  const result = parseOfficialNews(script([story({ story_summary: 'Body that must not be copied.' })]), source, school, men);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].publishedAt, '2026-09-16T00:00:00.000Z');
  assert.equal(result.records[0].publishedAtPrecision, 'day');
  assert.equal(result.records[0].imageUrl, 'https://athletics.example.edu/images/team.jpg');
  assert.ok(!JSON.stringify(result).includes('Body that'));
});
test('Nuxt Sidearm and WMT map verified item sports and photos', () => {
  const html = nuxt([
    { sub_headline: '', title: 'Men article', url: '/news/2026/9/16/men', date: '2026-09-16', sport: { title: "Men's Basketball" }, image: { url: '/images/m.jpg' } },
    { published_at: '2026-09-16T18:00:00Z', permalink: '/news/2026/9/16/women', title: 'Women article', visibility: 'public', sports: [{ title: "Women's Basketball" }], image: { url: '/images/w.jpg' } },
    { published_at: '2026-09-16T18:00:00Z', permalink: '/news/2026/9/16/private', title: 'Unpublished', visibility: 'private', sports: [{ title: "Women's Basketball" }] },
  ]);
  assert.deepEqual(parseOfficialNews(html, source, school, men).records.map(r => r.title), ['Men article']);
  assert.deepEqual(parseOfficialNews(html, source, school, women).records.map(r => r.title), ['Women article']);
});
test('explicit opposite gender wins over a shared archive route', () => {
  const sport = { slug: 'mens-cross-country', name: 'Cross Country', gender: 'men', routes: ['/sports/cross-country'], aliases: ['Cross Country'] };
  const html = script([story({ sport_title: "Women's Cross Country", story_path: '/news/2026/9/16/cross-country-women-win' }), story({ sport_title: 'Cross Country', story_path: '/news/2026/9/16/cross-country-teams-open' })]);
  const records = parseOfficialNews(html, source, school, sport).records;
  assert.equal(records.length, 1);
  assert.ok(records[0].url.endsWith('teams-open'));
});
test('RSS categories establish sport; generic feeds never inherit requested scope', () => {
  const xml = '<rss><channel><item><title>Women win</title><link>https://athletics.example.edu/news/2026/9/16/win</link><category>Women\'s Basketball</category><pubDate>Wed, 16 Sep 2026 20:00:00 GMT</pubDate><enclosure type="image/jpeg" url="https://cdn.example.edu/photo.jpg" /></item></channel></rss>';
  const result = parseOfficialNews(xml, 'https://athletics.example.edu/rss.aspx', school, women);
  assert.equal(result.records[0].publishedAtPrecision, 'instant');
  assert.equal(result.records[0].imageUrl, 'https://cdn.example.edu/photo.jpg');
  assert.throws(() => parseOfficialNews(xml, source, school, men), /No recognizable/);
  assert.throws(() => parseOfficialNews(xml.replace("<category>Women's Basketball</category>", ''), source, school, women), /No recognizable/);
});
test('static cards require category or a matching sport route', () => {
  const html = '<div class="sidearm-news-list-item"><div class="sidearm-news-list-item-title"><a href="/news/2026/9/16/mens-basketball-season">Season preview</a></div><time datetime="2026-09-16T12:00:00Z"></time><img src="/images/photo.jpg" /></div>';
  assert.equal(parseOfficialNews(html, source, school, men).records.length, 1);
  assert.throws(() => parseOfficialNews(html, source, school, women), /No recognizable/);
});
test('WordPress news cards use their category without requiring a /news URL prefix', () => {
  const html = '<section id="article-content-blocks"><div class="item"><div class="content-heading"><h2><a href="/season-preview/">Season preview</a></h2><a class="category">Basketball (M)</a></div><img src="/photo.jpg"></div></section>';
  assert.equal(parseOfficialNews(html, source, school, men).records[0].url, 'https://athletics.example.edu/season-preview/');
  assert.throws(() => parseOfficialNews(html, source, school, women), /No recognizable/);
});
test('archive client follows only its observed same-origin service with verified sport', async () => {
  const html = `<script>var sport_obj = ${JSON.stringify({ title: "Men's Basketball", shortname: 'mens-basketball' })}; $.get("/services/archives.ashx/stories", {});</script>`;
  let requested;
  const result = await collectOfficialNews(html, source, school, men, async url => { requested = url; return JSON.stringify({ error: null, data: [story()] }); });
  assert.equal(new URL(requested).origin, new URL(source).origin);
  assert.equal(new URL(requested).searchParams.get('sport'), 'mens-basketball');
  assert.equal(result.records[0].discoverySourceUrl, source);
  await assert.rejects(collectOfficialNews(html, source, school, women, async () => { throw Error('Must not fetch'); }), /No recognizable/);
});
test('archive follows observed archive link once and preserves discovery provenance', async () => {
  const home = source.replace('/archives', '');
  const result = await collectOfficialNews(`<a href="${source}">News</a>`, home, school, men, async url => { assert.equal(url, source); return script([story()]); });
  assert.equal(result.records[0].discoverySourceUrl, home);
});
test('unsafe URLs, malformed JSON and giant documents fail closed', () => {
  assert.throws(() => parseOfficialNews(script([story()]), 'https://attacker.example/news', school, men), /outside school scope/);
  assert.throws(() => parseOfficialNews(script([story({ story_path: 'https://attacker.example/news/1' })]), source, school, men), /No recognizable/);
  assert.throws(() => parseOfficialNews('<script id="__NUXT_DATA__" type="application/json">oops</script>', source, school, men), /Malformed/);
  assert.throws(() => parseOfficialNews('x'.repeat(8_000_001), source, school, men), /size/);
});
