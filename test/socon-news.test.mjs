import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { collectSoconNews } from '../src/adapters/socon-news.mjs';
import { SourceError } from '../src/network.mjs';

const school = await getSchool('tennessee-technological-university');
const sport = school.sports.find(value => value.slug === 'football');
const source = 'https://soconsports.com/archives.aspx?path=football';
const member = { id: 47, ncaa_id: 692, title: 'Tennessee Tech', abbreviation: 'TTU', school_active: true };
const json = data => JSON.stringify({ error: null, data });
const row = (extra = {}) => ({ story_headline: 'SoCon Interview: Casey Fox, TTU Athletic Director', story_summary: '<p>Football interview.</p>',
  sports_cats: 'Football', story_path: '/news/2026/10/20/football-socon-interview-casey-fox-ttu-athletic-director.aspx',
  story_postdate: '10/20/2026', story_image: '/images/2026/10/20/Casey.png', ...extra });
function html(identity = { id: 2, title: 'Football', shortname: 'football' }) {
  return `<script>var sport_obj = ${JSON.stringify(identity)};
    $.get('/services/archives.ashx/stories', { school: this.school, sport: this.sport });
    $.get('/services/archives.ashx/setup_schools_dropdown', {});</script>`;
}
async function collect(rows = [row()], options = {}) {
  const calls = [], selected = options.sport ?? sport, url = options.source ?? source;
  const result = await collectSoconNews(options.html ?? html(), url, options.school ?? school, selected, async request => {
    calls.push(request);
    if (request === 'https://soconsports.com/services/archives.ashx/setup_schools_dropdown') return options.members ?? json([member]);
    const target = new URL(request);
    if (target.pathname === '/services/archives.ashx/stories') return json(target.searchParams.get('school') === '0' ? rows : options.filtered ?? []);
    const response = options.articles?.[request] ?? '<div class="sidearm-story-template-text">Tennessee Tech competes in the Southern Conference.</div>';
    if (response instanceof Error) throw response;
    return response;
  });
  assert.ok(calls.length <= 15);
  return { ...result, calls };
}

test('SoCon migration reads declared Sidearm archives with current publication date and conference photo', async () => {
  const result = await collect(), record = result.records[0];
  assert.equal(result.emptyConfirmed, false);
  assert.equal(record.title, row().story_headline);
  assert.equal(record.url, new URL(row().story_path, source).href);
  assert.equal(record.publishedAt, '2026-10-20T00:00:00.000Z');
  assert.equal(record.publishedAtPrecision, 'day');
  assert.equal(record.publisher, 'The Southern Conference');
  assert.equal(record.discoverySourceUrl, source);
  assert.equal(record.imageUrl, 'https://soconsports.com/images/2026/10/20/Casey.png');
  assert.ok(!JSON.stringify(result).includes('Football interview.'));
  assert.equal(result.calls.length, 3);
});

test('SoCon merges current untagged headlines with deeper school-tagged stories and validates current article bodies', async () => {
  const extra = row({ story_headline: 'SoCon names football players of the week', story_path: '/news/2026/9/28/socon-football-honors.aspx', story_postdate: '9/28/2026', story_summary: 'Weekly conference honors.' });
  const stale = row({ story_headline: 'Other teams win', story_path: '/news/2026/9/20/other.aspx', story_summary: 'Tennessee Tech appeared in a stale teaser.' });
  const result = await collect([row(), stale], { filtered: [extra, stale], articles: { [new URL(stale.story_path, source).href]: '<div class="sidearm-story-template-text">Only Furman won this game.</div>' } });
  assert.deepEqual(result.records.map(value => value.title), [row().story_headline, extra.story_headline]);
  assert.equal(result.calls.filter(url => url.endsWith('/other.aspx')).length, 1);
});

test('SoCon rejects wrong school, sport, gender, and cross-sport classifications', async () => {
  const wrong = [row({ story_headline: 'Texas Tech wins', story_summary: '', story_path: '/news/2026/10/20/texas.aspx' }),
    row({ sports_cats: "Women's Basketball", story_path: '/news/2026/10/20/women.aspx' }),
    row({ sports_cats: 'Football, Baseball', story_path: '/news/2026/10/20/shared.aspx' })];
  assert.deepEqual((await collect([row(), ...wrong])).records.map(value => value.title), [row().story_headline]);
  const women = school.sports.find(value => value.slug === 'womens-basketball');
  const menRow = row({ story_headline: 'Tennessee Tech men ready for basketball', sports_cats: "Men's Basketball" });
  await assert.rejects(collect([menRow], { sport: women, source: 'https://soconsports.com/archives.aspx?path=wbball', html: html({ id: 13, title: "Women's Basketball", shortname: 'wbball' }) }), /No recognizable/);
});

test('SoCon school tags alone never turn unrelated or inaccessible article bodies into records', async () => {
  const item = row({ story_headline: 'SoCon Five Football Points', story_summary: 'Tennessee Tech in an obsolete teaser.' });
  const url = new URL(item.story_path, source).href;
  for (const response of [new SourceError('http-405'), '<nav>Tennessee Tech</nav><main>Other school wins.</main>',
    '<div class="sidearm-story-template-text"><script>Tennessee Tech</script>Other school wins.</div>',
    '<div class="sidearm-story-template-text">Tennessee Tech</div><div class="sidearm-story-template-text">Other school</div>']) {
    await assert.rejects(collect([], { filtered: [item], articles: { [url]: response } }), /No recognizable/);
  }
});

test('SoCon verifies member and archive identity before collecting stories', async () => {
  for (const members of [[], [member, member], [{ ...member, ncaa_id: 999 }], [{ ...member, title: 'Texas Tech' }], [{ ...member, school_active: false }]]) {
    await assert.rejects(collect([], { members: json(members) }), /Unverified/);
  }
  for (const options of [{ source: 'https://soconsports.com/fb/' }, { source: 'https://soconsports.com/archives.aspx?path=baseball' },
    { school: { ...school, ncaaId: 999 } }, { sport: { ...sport, code: 'WBB' } }, { sport: { ...sport, gender: 'women' } },
    { html: html({ id: 4, title: "Men's Basketball", shortname: 'mbball' }) }, { html: html() + html() }]) {
    await assert.rejects(collect([row()], options), /Unreviewed|Unverified|catalog|ambiguous/);
  }
});

test('SoCon keeps truly absent baseball coverage unavailable instead of inventing an empty success', async () => {
  const baseball = school.sports.find(value => value.slug === 'baseball');
  await assert.rejects(collect([], { sport: baseball, source: 'https://soconsports.com/archives.aspx?path=baseball', html: html({ id: 1, title: 'Baseball', shortname: 'baseball' }) }), /No recognizable/);
});

test('SoCon respects source dates instead of inferring dates from article URLs and strips unsafe images', async () => {
  assert.equal((await collect([row({ story_postdate: '9/2/2026' })])).records[0].publishedAt, '2026-09-02T00:00:00.000Z');
  for (const date of [null, '', 'yesterday', '2/30/2026']) {
    const record = (await collect([row({ story_postdate: date })])).records[0];
    assert.equal(record.publishedAt, null);
    assert.equal(record.publishedAtPrecision, 'unknown');
  }
  for (const image of ['https://127.0.0.1/photo.png', 'https://other.example/photo.png', '/images/photo.png?signature=secret']) {
    assert.equal((await collect([row({ story_image: image })])).records[0].imageUrl, null);
  }
});

test('SoCon migrated article-wrapper bodies establish school scope without counting headers or menus', async () => {
  const item = row({ story_headline: 'SoCon announces its football schedule', story_summary: '' });
  const url = new URL(item.story_path, source).href;
  const wrapper = content => `<nav>Tennessee Tech</nav><main><article class="article-wrapper news"><div class="article-content"><header>Tennessee Tech sidebar</header><div>${content}</div></div></article></main>`;
  assert.equal((await collect([], { filtered: [item], articles: { [url]: wrapper('<p>Tennessee Tech will play Furman.</p>') } })).records.length, 1);
  for (const body of [wrapper('<p>Only Furman is mentioned.</p>'), wrapper('<script>Tennessee Tech</script>Only Furman.'),
    wrapper('Tennessee Tech') + wrapper('Other school')]) {
    await assert.rejects(collect([], { filtered: [item], articles: { [url]: body } }), /No recognizable/);
  }
});
