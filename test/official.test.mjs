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
test('duplicate visual cards preserve the structured publication date and available photo', () => {
  const path = '/news/2026/9/16/mens-basketball-season-preview';
  const structured = nuxt([{ sub_headline: '', title: 'Season preview', url: path, date: '2026-09-16T15:00:00', sport: { title: "Men's Basketball" }, image: { url: '/images/preview.jpg', alt_text: 'Team preview' } }]);
  const card = `<article class="c-stories__item"><a class="c-stories__title" href="${path}">Season preview</a><abbr class="c-item-details__sport-text" title="Men's Basketball">MBB</abbr></article>`;
  const result = parseOfficialNews(structured + card, source, school, men).records;
  assert.equal(result.length, 1);
  assert.equal(result[0].publishedAt, '2026-09-16T00:00:00.000Z');
  assert.equal(result[0].publishedAtPrecision, 'day');
  assert.equal(result[0].imageUrl, 'https://athletics.example.edu/images/preview.jpg');
  assert.equal(result[0].imageAlt, 'Team preview');
  const precise = structured.replace('2026-09-16T15:00:00', '2026-09-16T15:00:00Z');
  const sparse = card.replace('</article>', '<time datetime="2026-09-16"></time><img src="/images/preview.jpg"></article>');
  const merged = parseOfficialNews(precise + sparse, source, school, men).records[0];
  assert.equal(merged.publishedAt, '2026-09-16T15:00:00.000Z');
  assert.equal(merged.publishedAtPrecision, 'instant');
  assert.equal(merged.imageAlt, 'Team preview');
});
test('explicit opposite gender wins over a shared archive route', () => {
  const sport = { slug: 'mens-cross-country', name: 'Cross Country', gender: 'men', routes: ['/sports/cross-country'], aliases: ['Cross Country'] };
  const html = script([story({ sport_title: "Women's Cross Country", story_path: '/news/2026/9/16/cross-country-women-win' }), story({ sport_title: 'Cross Country', story_path: '/news/2026/9/16/cross-country-teams-open' })]);
  const records = parseOfficialNews(html, source, school, sport).records;
  assert.equal(records.length, 1);
  assert.ok(records[0].url.endsWith('teams-open'));
});
test('primary team gender outranks cross-posted categories in classic and Nuxt archives', () => {
  const mens = { slug: 'mens-squash', name: "Men's Squash", gender: 'men', code: 'MSQ' };
  const womens = { slug: 'womens-squash', name: "Women's Squash", gender: 'women', code: 'WSQ' };
  const title = "Men's Squash Advances to CSA Semifinals";
  const path = '/news/2025/3/7/mens-squash-advances-to-csa-semifinals.aspx';
  const primary = "Men's Squash", categories = "Men's Squash, Women's Squash";
  const documents = [
    script([story({ story_headline: title, story_path: path, sport_title: primary, sports_cats: categories })]),
    nuxt([{ storyHeadline: title, storyPath: path, storyPostdate: '2025-03-07', sportTitle: primary, sportsCats: categories }]),
  ];
  for (const html of documents) {
    assert.equal(parseOfficialNews(html, source, school, mens).records.length, 1);
    assert.throws(() => parseOfficialNews(html, source, school, womens), /No recognizable/);
    const crosspostedCard = `<article class="c-stories__item"><a class="c-stories__title" href="${path}">${title}</a><abbr class="c-item-details__sport-text" title="Women's Squash">WSQ</abbr></article>`;
    assert.throws(() => parseOfficialNews(html + crosspostedCard, source, school, womens), /No recognizable/);
    assert.equal(parseOfficialNews(html + crosspostedCard, source, school, mens).records.length, 1);
  }
  const shared = script([story({ sport_title: 'Squash', sports_cats: categories, story_path: '/news/2026/9/16/squash-teams-honored.aspx' })]);
  assert.equal(parseOfficialNews(shared, source, school, mens).records.length, 1);
  assert.equal(parseOfficialNews(shared, source, school, womens).records.length, 1);
});
test('verified combined labels match whole before comma-separated category fallback', () => {
  const sport = { slug: 'mens-cross-country', name: 'Cross Country', gender: 'men', aliases: ['Track & Field, XC'] };
  const html = script([story({ sport_title: 'Track & Field, XC', story_path: '/news/2026/9/16/team-honors' })]);
  assert.equal(parseOfficialNews(html, source, school, sport).records.length, 1);
  assert.throws(() => parseOfficialNews(html, source, school, { ...sport, aliases: [] }), /No recognizable/);
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
test('shared all-sports archives require per-article scope and do not confirm an absent sport empty', async () => {
  const archive = 'https://athletics.example.edu/archives';
  const html = script([story(), story({ story_headline: 'Women season', story_path: '/news/2026/9/16/women-season', sport_title: "Women's Basketball" })]);
  const records = (await collectOfficialNews(html, archive, school, men, async () => { throw new Error('Unexpected network call'); })).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'A new season');
  await assert.rejects(collectOfficialNews(script([story({ sport_title: 'General' })]), archive, school, men, async () => { throw new Error('Unexpected network call'); }), /No recognizable/);
  await assert.rejects(collectOfficialNews(script([]), archive, school, men, async () => { throw new Error('Unexpected network call'); }), /No recognizable/);
});
test('unsafe URLs, malformed JSON and giant documents fail closed', () => {
  assert.throws(() => parseOfficialNews(script([story()]), 'https://attacker.example/news', school, men), /outside school scope/);
  assert.throws(() => parseOfficialNews(script([story({ story_path: 'https://attacker.example/news/1' })]), source, school, men), /No recognizable/);
  assert.throws(() => parseOfficialNews('<script id="__NUXT_DATA__" type="application/json">oops</script>', source, school, men), /Malformed/);
  assert.throws(() => parseOfficialNews('x'.repeat(8_000_001), source, school, men), /size/);
});
