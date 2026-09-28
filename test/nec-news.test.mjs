import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { SourceError } from '../src/network.mjs';
import { collectNecFootballNews } from '../src/adapters/nec-news.mjs';

const school = await getSchool('central-connecticut-state-university');
const sport = school.sports.find(value => value.slug === 'football');
const source = 'https://necsports.com/archives.aspx?path=football';
const membersUrl = 'https://necsports.com/services/archives.ashx/setup_schools_dropdown';
const storiesUrl = 'https://necsports.com/services/archives.ashx/stories?index=1&page_size=30&sport=football&season=0&school=0&search=';
const html = `<script>var sport_obj = {"id":244,"title":"Football","shortname":"football"};
  $.get("/services/archives.ashx/stories", { index: this.current_page, page_size: this.page_size, sport: this.sport, season: this.season, school: this.school, search: this.query });
  $.get("/services/archives.ashx/setup_schools_dropdown", {});</script>`;
const member = { id: 146, ncaa_id: 127, title: school.name, abbreviation: 'CCSU', school_active: true };
const row = (extra = {}) => ({ story_headline: 'CCSU sets sights on NEC football title', story_summary: '<p>Season preview.</p>',
  sports_cats: 'Football', story_path: '/news/2026/7/25/FB_PreseasonPollRel_26.aspx', story_postdate: '8/3/2026',
  story_image: '/images/2026/7/30/preseason.jpg', ...extra });
const json = rows => JSON.stringify({ error: null, data: rows });
async function collect(rows = [row()], options = {}) {
  const calls = [];
  const result = await collectNecFootballNews(options.html ?? html, options.source ?? source,
    options.school ?? school, options.sport ?? sport, async url => {
      calls.push(url);
      if (url === membersUrl) return options.members ?? json([member]);
      if (url === storiesUrl) return options.stories ?? json(rows);
      throw new Error(`Unexpected request: ${url}`);
    });
  assert.deepEqual(calls, [membersUrl, storiesUrl]);
  return result;
}

test('NEC follows declared public services and preserves conference provenance, date, and photo', async () => {
  const result = await collect(), record = result.records[0];
  assert.equal(result.emptyConfirmed, false);
  assert.equal(result.records.length, 1);
  assert.equal(record.title, 'CCSU sets sights on NEC football title');
  assert.equal(record.url, 'https://necsports.com/news/2026/7/25/FB_PreseasonPollRel_26.aspx');
  assert.equal(record.publishedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(record.publishedAtPrecision, 'day');
  assert.equal(record.imageUrl, 'https://necsports.com/images/2026/7/30/preseason.jpg');
  assert.equal(record.publisher, 'Northeast Conference');
  assert.equal(record.author, null);
  assert.equal(record.discoverySourceUrl, source);
  assert.ok(!JSON.stringify(result).includes('Season preview'));
});

test('NEC requires direct school identification and exclusive football category', async () => {
  const rows = [row(), row({ story_headline: '#NECFB Two-Sentence Summaries (Week 4)', story_summary: 'Central Connecticut State University wins this week.', story_path: '/news/2026/9/27/field-hockey-necfb-two-sentence-summaries-week-4.aspx', story_postdate: '9/27/2026' }),
    row({ story_headline: 'Other school wins', story_summary: 'No school identification here.', story_path: '/news/2026/8/5/other.aspx' }),
    row({ story_headline: 'XCCSUX honored', story_summary: '', story_path: '/news/2026/8/6/substrings.aspx' }),
    row({ sports_cats: 'Football, Baseball', story_path: '/news/2026/8/7/shared.aspx' }),
    row({ sports_cats: 'Baseball', story_path: '/news/2026/8/8/baseball.aspx' }),
    row({ story_headline: 'Football honors', story_summary: '<script>CCSU</script>', story_path: '/news/2026/8/9/script.aspx' })];
  const result = await collect(rows);
  assert.equal(result.records.length, 2);
  assert.ok(result.records[1].url.endsWith('/field-hockey-necfb-two-sentence-summaries-week-4.aspx'));
  assert.equal(result.records[1].publishedAt, '2026-09-27T00:00:00.000Z');
});

test('NEC rejects unreviewed source and catalog identities before requesting services', async () => {
  for (const args of [
    [html, 'https://necsports.com/archives.aspx?path=baseball', school, sport],
    [html, source, { ...school, ncaaId: 999 }, sport],
    [html, source, { ...school, name: 'Forged school' }, sport],
    [html, source, school, { ...sport, code: 'MBA' }],
    [html, source, school, school.sports.find(value => value.slug === 'baseball')],
  ]) {
    let calls = 0;
    await assert.rejects(collectNecFootballNews(...args, async () => { calls++; }), /catalog|Unreviewed/);
    assert.equal(calls, 0);
  }
});

test('NEC requires one declared football service and never evaluates script text', async () => {
  for (const text of ['', html + html, html.replace('"Football"', '"Baseball"'), html.replace('"/services/archives.ashx/stories"', '"https://other.example/stories"'),
    html.replace('var sport_obj =', 'var sport_obj = untrustedFunction() ||')]) {
    let calls = 0;
    await assert.rejects(collectNecFootballNews(text, source, school, sport, async () => { calls++; }));
    assert.equal(calls, 0);
  }
});

test('NEC verifies the school filter against the live service identity before reading stories', async () => {
  for (const rows of [[], [member, member], [{ ...member, ncaa_id: 999 }], [{ ...member, title: 'Other school' }],
    [{ ...member, abbreviation: 'OTHER' }], [{ ...member, school_active: false }]]) {
    const calls = [];
    await assert.rejects(collectNecFootballNews(html, source, school, sport, async url => { calls.push(url); return json(rows); }), /Unverified/);
    assert.deepEqual(calls, [membersUrl]);
  }
});

test('NEC rejects malformed, over-budget, and unusable responses', async () => {
  for (const stories of ['{invalid', json([]), json([null]), JSON.stringify({ error: 'denied', data: [row()] }), json(Array(31).fill(row())),
    json([row({ story_headline: 'x'.repeat(4097) })]), json([row({ story_summary: 'x'.repeat(20_001) })])]) {
    await assert.rejects(collect([], { stories }));
  }
  await assert.rejects(collect([], { html: ' '.repeat(8_000_001) }), /size/);
});

test('NEC discards unsafe URLs and does not invent publication dates', async () => {
  for (const path of ['https://other.example/news/2026/1/1/article.aspx', 'https://127.0.0.1/news/2026/1/1/article.aspx', '/news/2026/1/1/article.aspx?token=secret']) {
    await assert.rejects(collect([row({ story_path: path })]), /No recognizable/);
  }
  for (const image of ['https://127.0.0.1/image.jpg', 'https://other.example/image.jpg', '/images/photo.jpg?signature=secret']) {
    assert.equal((await collect([row({ story_image: image })])).records[0].imageUrl, null);
  }
  for (const date of [null, '', 'yesterday', '2/30/2026']) {
    const record = (await collect([row({ story_postdate: date })])).records[0];
    assert.equal(record.publishedAt, null);
    assert.equal(record.publishedAtPrecision, 'unknown');
  }
});

test('NEC propagates service denials without requesting other endpoints', async () => {
  const calls = [];
  await assert.rejects(collectNecFootballNews(html, source, school, sport, async url => {
    calls.push(url);
    if (url === membersUrl) return json([member]);
    throw new SourceError('http-405');
  }), error => error.code === 'http-405');
  assert.deepEqual(calls, [membersUrl, storiesUrl]);
});
