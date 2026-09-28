import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool, getSport } from '../src/config.mjs';
import { conferenceFootballSource, conferenceFootballSources } from '../src/adapters/conference-football.mjs';

const targets = [
  ['central-connecticut-state-university', 'https://necsports.com/archives.aspx?path=football'],
  ['tennessee-technological-university', 'https://soconsports.com/fb/'],
];

test('conference replacements are limited to the two reviewed football programs', async () => {
  assert.deepEqual(Object.keys(conferenceFootballSources).sort(), targets.map(([slug]) => slug).sort());
  for (const [slug, url] of targets) {
    const school = await getSchool(slug), football = getSport(school, 'football');
    const reviewed = conferenceFootballSources[slug], source = conferenceFootballSource(school, football);
    assert.equal(reviewed.ncaaId, String(school.ncaaId));
    assert.equal(reviewed.conference, football.conference.slug);
    assert.equal(source.url, url);
    assert.deepEqual(source.allowedHosts, [new URL(url).hostname]);
    for (const sport of ['basketball', 'womens-basketball', 'baseball']) {
      assert.equal(conferenceFootballSource(school, getSport(school, sport)), null);
    }
  }
  const other = await getSchool('oregon-state-university');
  assert.equal(conferenceFootballSource(other, getSport(other, 'football')), null);
});

test('conference replacements resolve canonical school and sport identities', async () => {
  for (const [slug, url] of targets) {
    const school = await getSchool(slug), football = getSport(school, 'football');
    assert.throws(() => conferenceFootballSource({ ...school, ncaaId: 999 }, football), /catalog/);
    assert.throws(() => conferenceFootballSource({ ...school, name: 'Another university' }, football), /catalog/);
    assert.throws(() => conferenceFootballSource(school, { ...football, code: 'MBA' }), /identity mismatch/);
    // Caller-supplied membership cannot choose a different conference source.
    const forgedSport = { ...football, conference: { slug: 'another-conference', name: 'Another Conference' } };
    const source = conferenceFootballSource({ ...school, sports: [forgedSport] }, forgedSport);
    assert.equal(source.url, url);
  }
});
