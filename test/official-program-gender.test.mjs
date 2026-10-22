import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOfficialNews, parseOfficialNews } from '../src/adapters/official.mjs';
const base = 'https://athletics.example.edu/';
const rifle = { slug: 'coed-rifle', name: 'Mixed Rifle', gender: 'coed', routes: ['/sports/mens-rifle'], aliases: ['Rifle'] };
const lightweight = { slug: 'mens-lightweight-crew', name: "Men's Lightweight Crew", gender: 'men', routes: ['/sports/mens-lightweight-rowing'] };
const school = { slug: 'example', name: 'Example University', athleticsUrl: base, sports: [rifle, lightweight, { slug: 'womens-rowing', name: "Women's Rowing", gender: 'women' }] };
const archive = token => `${base}sports/${token}/archives`;
const document = metadata => `<script>var sport_obj = ${JSON.stringify(metadata)}; $.get('/services/archives.ashx/stories', {});</script>`;
const story = (title, sport_title, path) => ({ story_headline: title, sport_title, story_path: path, story_postdate: '10/21/2026', story_image: '/photo.jpg' });
const payload = records => JSON.stringify({ data: records });

test('catalog-confirmed coed rifle accepts an ungendered title on a legacy binary-gender route', async () => {
  const metadata = { title: 'Rifle', shortname: 'rifle', global_sport_name_slug: 'mens-rifle', gender: 'm', non_sport: false };
  const result = await collectOfficialNews(document(metadata), archive('mens-rifle'), school, rifle, async () => payload([
    story('Rifle hosts weekend matches', 'Rifle', '/news/2026/10/21/rifle-hosts-weekend'),
    story('Men-only recap', "Men's Rifle", '/news/2026/10/21/mens-rifle-recap'),
    story('Women-only recap', "Women's Rifle", '/news/2026/10/21/womens-rifle-recap'),
  ]));
  assert.deepEqual(result.records.map(r => r.title), ['Rifle hosts weekend matches']);
  assert.equal(result.records[0].publishedAt, '2026-10-21T00:00:00.000Z');
  assert.equal(result.records[0].imageUrl, `${base}photo.jpg`);
});

test('unrelated Nuxt menu declarations cannot grant sport scope through a matching public title', () => {
  const table = [];
  const add = value => {
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value) ? value.map(add) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, add(item)])) : value;
    return index;
  };
  add({ title: "Men's Lightweight Rowing", shortname: 'unrelated-program', global_sport_name_slug: 'unrelated-program', gender: 'f', non_sport: false });
  add({ sub_headline: null, title: 'Unrelated program news', url: '/news/2026/10/21/unrelated-program-story', sport: null, date: '2026-10-21' });
  const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(table)}</script>`;
  assert.throws(() => parseOfficialNews(html, archive('mens-lightweight-rowing'), school, lightweight), /No recognizable/);
});

test('coed rifle exception rejects explicit gender, other sports and an ambiguous split inventory', async () => {
  const metadata = { title: 'Rifle', shortname: 'rifle', global_sport_name_slug: 'mens-rifle', gender: 'm', non_sport: false };
  for (const title of ["Men's Rifle", "Women's Rifle", 'Basketball']) {
    await assert.rejects(collectOfficialNews(document({ ...metadata, title }), archive('mens-rifle'), school, rifle, async () => assert.fail('Unverified program requested')), /No recognizable/);
  }
  const splitSchool = { ...school, sports: [...school.sports, { slug: 'mens-rifle', name: "Men's Rifle", gender: 'men' }] };
  await assert.rejects(collectOfficialNews(document(metadata), archive('mens-rifle'), splitSchool, rifle, async () => assert.fail('Split program scope is ambiguous')), /No recognizable/);
});

test('explicit lightweight program title outranks its inconsistent generic gender field', async () => {
  const metadata = { title: "Men's Lightweight Rowing", shortname: 'mlrow', global_sport_name_slug: 'mens-lightweight-rowing', gender: 'f', non_sport: false };
  const result = await collectOfficialNews(document(metadata), archive('mens-lightweight-rowing'), school, lightweight, async () => payload([
    story('Lightweight assistant announced', "Men's Lightweight Rowing", '/news/2026/10/21/mens-lightweight-rowing-assistant'),
    story('Women recap', "Women's Rowing", '/news/2026/10/21/womens-rowing-recap'),
    story('Heavyweight recap', "Men's Heavyweight Rowing", '/news/2026/10/21/mens-heavyweight-rowing-recap'),
  ]));
  assert.deepEqual(result.records.map(r => r.title), ['Lightweight assistant announced']);
});

test('an explicit title cannot override the requested gender, family or verified source route', async () => {
  for (const title of ["Women's Lightweight Rowing", "Men's Basketball"]) {
    const metadata = { title, shortname: 'mlrow', gender: 'f', non_sport: false };
    await assert.rejects(collectOfficialNews(document(metadata), archive('mens-lightweight-rowing'), school, lightweight, async () => assert.fail('Wrong program requested')), /No recognizable/);
  }
  const metadata = { title: "Men's Lightweight Rowing", shortname: 'mlrow', gender: 'f', non_sport: false };
  await assert.rejects(collectOfficialNews(document(metadata), archive('womens-rowing'), school, lightweight, async () => assert.fail('Wrong source route requested')), /No recognizable/);
});
