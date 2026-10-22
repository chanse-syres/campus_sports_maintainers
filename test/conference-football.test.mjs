import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool, getSport } from '../src/config.mjs';
import { conferenceNewsSource, conferenceNewsSources, conferenceFootballSource } from '../src/adapters/conference-football.mjs';

const targets = [
  ['central-connecticut-state-university', 'necsports.com'],
  ['tennessee-technological-university', 'soconsports.com'],
];

test('conference replacements cover only reviewed sponsored sports at the two verified members', async () => {
  assert.deepEqual(Object.keys(conferenceNewsSources).sort(), targets.map(([slug]) => slug).sort());
  assert.equal(conferenceFootballSource, conferenceNewsSource);
  for (const [slug, host] of targets) {
    const school = await getSchool(slug), reviewed = conferenceNewsSources[slug];
    assert.equal(reviewed.ncaaId, String(school.ncaaId));
    for (const [sportSlug, path] of Object.entries(reviewed.sports)) {
      const sport = getSport(school, sportSlug), source = conferenceNewsSource(school, sport);
      assert.equal(reviewed.conference, sport.conference.slug);
      assert.equal(source.url, `https://${host}/archives.aspx?path=${path}`);
      assert.deepEqual(source.allowedHosts, [host]);
    }
    for (const sport of school.sports.filter(value => !reviewed.sports[value.slug])) assert.equal(conferenceNewsSource(school, sport), null);
  }
  const other = await getSchool('oregon-state-university');
  assert.equal(conferenceNewsSource(other, getSport(other, 'football')), null);
});

test('conference replacements resolve canonical school, sport, and conference identities', async () => {
  for (const [slug, host] of targets) {
    const school = await getSchool(slug), football = getSport(school, 'football');
    assert.throws(() => conferenceNewsSource({ ...school, ncaaId: 999 }, football), /catalog/);
    assert.throws(() => conferenceNewsSource({ ...school, name: 'Another university' }, football), /catalog/);
    assert.throws(() => conferenceNewsSource(school, { ...football, code: 'MBA' }), /identity mismatch/);
    const forgedSport = { ...football, conference: { slug: 'another-conference', name: 'Another Conference' } };
    const source = conferenceNewsSource({ ...school, sports: [forgedSport] }, forgedSport);
    assert.equal(source.url, `https://${host}/archives.aspx?path=football`);
  }
});
