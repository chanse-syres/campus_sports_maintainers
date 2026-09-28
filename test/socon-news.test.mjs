import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { stableId } from '../src/normalize.mjs';
import { parseSoconFootballNews } from '../src/adapters/socon-news.mjs';

const school = await getSchool('tennessee-technological-university');
const sport = school.sports.find(value => value.slug === 'football');
const source = 'https://soconsports.com/fb/';
const collection = '$inf$#sports:@"fb",,skip:0,schools:@,limit:20,language:"en-us",feedType:"sport",contentTypeUid:"article",';
const row = (extra = {}) => ({
  id: 60372, _content_type_uid: 'article', _status: 'published', _in_progress: false,
  title: 'internal-cms-name', simple_headline: 'SoCon names football players of the week',
  complex_headline: 'Tennessee Tech and Furman honored', publish_date: '2026-09-14T19:00:00.000Z',
  image: { url: 'https://img.boostsport.ai/boost-cms/weekly honors.png' },
  sport: [{ id: 31, alias: 'fb', title: 'Football' }], school: [{ id: 884, alias: 'TTU', title: 'Tennessee Tech' }],
  body: '<p>Full article body must never appear in records.</p>', ...extra,
});
function page(rows, { links = rows.map(value => `/fb/article/${value.id}/`), params = { sport: 'fb' }, fallback = { [collection]: rows } } = {}) {
  return links.map(href => `<a href="${href}">Public article</a>`).join('')
    + `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { params, fallback } } }).replaceAll('<', '\\u003c')}</script>`;
}
const parse = text => parseSoconFootballNews(text, source, school, sport);

test('SoCon maps published football articles tagged for Tennessee Tech with conference provenance', () => {
  const result = parse(page([row()])), record = result.records[0];
  assert.equal(result.emptyConfirmed, false);
  assert.equal(result.records.length, 1);
  assert.deepEqual(record, {
    id: stableId(school.slug, sport.slug, 'https://soconsports.com/fb/article/60372/'),
    title: 'SoCon names football players of the week', url: 'https://soconsports.com/fb/article/60372/',
    publishedAt: '2026-09-14T19:00:00.000Z', publishedAtPrecision: 'instant',
    imageUrl: 'https://img.boostsport.ai/boost-cms/weekly%20honors.png', imageAlt: null,
    author: null, publisher: 'The Southern Conference', discoverySourceUrl: source,
  });
  assert.ok(!JSON.stringify(result).includes('Full article body'));
  assert.ok(!JSON.stringify(result).includes('internal-cms-name'));
});

test('SoCon school and sport tags exclude unrelated, unscoped, unpublished, and unrendered records', () => {
  const variants = [
    { school: [] }, { school: [{ id: 563, alias: 'WCU', title: 'Western Carolina' }] },
    { school: [{ id: 884, alias: 'OTHER', title: 'Tennessee Tech' }] },
    { sport: [{ id: 32, alias: 'baseball', title: 'Baseball' }] }, { sport: [] },
    { _status: 'draft' }, { _in_progress: true }, { _content_type_uid: 'video' },
  ];
  const rows = [row(), ...variants.map((extra, index) => row({ id: 61000 + index, ...extra })), row({ id: 61999 })];
  const result = parse(page(rows, { links: rows.filter(value => value.id !== 61999).map(value => `/fb/article/${value.id}/`) }));
  assert.deepEqual(result.records.map(value => value.url), ['https://soconsports.com/fb/article/60372/']);
});

test('SoCon requires a canonical catalog identity, football program, and exact reviewed source', async () => {
  const html = page([row()]);
  for (const url of ['https://soconsports.com/fb/feed', 'https://soconsports.com/fb/?path=football', 'https://other.example/fb/']) {
    assert.throws(() => parseSoconFootballNews(html, url, school, sport), /Unreviewed/);
  }
  assert.throws(() => parseSoconFootballNews(html, source, { ...school, name: 'Forged name' }, sport), /catalog/);
  assert.throws(() => parseSoconFootballNews(html, source, { ...school, ncaaId: 999 }, sport), /catalog/);
  assert.throws(() => parseSoconFootballNews(html, source, school, { ...sport, code: 'MBA' }), /Unreviewed/);
  assert.throws(() => parseSoconFootballNews(html, source, school, school.sports.find(value => value.slug === 'baseball')), /Unreviewed/);
  const other = await getSchool('central-connecticut-state-university');
  assert.throws(() => parseSoconFootballNews(html, source, other, other.sports.find(value => value.slug === 'football')), /Unreviewed/);
});

test('SoCon excludes foreign, private, signed, and noncanonical article links', () => {
  for (const link of ['https://other.example/fb/article/60372/', 'https://127.0.0.1/fb/article/60372/',
    'https://soconsports.com/fb/article/60372/?token=secret', '/fb/article/60372/#detail', '/mbb/article/60372/']) {
    assert.throws(() => parse(page([row()], { links: [link] })), /No recognizable/);
  }
});

test('SoCon excludes unsafe or unreviewed images without losing the scoped article', () => {
  for (const url of ['https://127.0.0.1/image.jpg', 'https://private.internal/image.jpg', 'http://img.boostsport.ai/boost-cms/image.jpg',
    'https://other.example/image.jpg', 'https://img.boostsport.ai/boost-cms/image.jpg?signature=secret', 'https://img.boostsport.ai/other/image.jpg']) {
    assert.equal(parse(page([row({ image: { url } })])).records[0].imageUrl, null);
  }
});

test('SoCon preserves exact UTC publication times and leaves invalid or missing dates unknown', () => {
  assert.equal(parse(page([row({ publish_date: '2026-09-14T19:00:00Z' })])).records[0].publishedAt, '2026-09-14T19:00:00.000Z');
  for (const date of [null, undefined, '', 'yesterday', '2026-09-14', '2026-02-30T19:00:00.000Z', '2026-09-14T25:00:00.000Z']) {
    const record = parse(page([row({ publish_date: date })])).records[0];
    assert.equal(record.publishedAt, null);
    assert.equal(record.publishedAtPrecision, 'unknown');
  }
});

test('SoCon rejects missing, malformed, ambiguous, or empty declared page data', () => {
  for (const text of ['', '<script id="__NEXT_DATA__" type="application/json">{not-json</script>',
    page([row()]) + page([row()]), page([row()], { params: { sport: 'baseball' } }),
    page([], { fallback: {} }), page([]), page([null], { links: [] }),
    page([row()], { fallback: { [collection]: [row()], 'contentTypeUid:"article",other': [row()] } })]) {
    assert.throws(() => parse(text));
  }
});

test('SoCon enforces document, collection, article, tag, link, and field budgets', () => {
  for (const text of [' '.repeat(8_000_001), page(Array.from({ length: 101 }, (_, index) => row({ id: index + 1 }))),
    page([row({ simple_headline: 'x'.repeat(4097) })]), page([row({ school: Array(101).fill({}) })]),
    page([row()], { links: Array(5001).fill('/fb/article/60372/') }),
    page([row()], { fallback: { [collection]: [row()], ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`other${index}`, []])) } })]) {
    assert.throws(() => parse(text), /budget|size/);
  }
});
