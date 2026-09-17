import test from 'node:test';
import assert from 'node:assert/strict';
import { athleticsUrl, parseSponsoredSports, sportSlug } from './import-ncaa.mjs';

const source = 'https://web3.ncaa.org/directory/orgDetail?id=123';
const labels = new Map([["Men's Basketball", 'MBB'], ['Mixed Rifle', 'XRI']]);
const row = (name, division, conference) => `<tr><td>${name}</td><td>Staff field must not be retained</td><td>${division}</td><td>${conference}</td><td></td></tr>`;
const page = rows => `<div class="panel"><div class="panel-heading">Sponsored Sports for the <span>2026-2027</span> Academic Year</div><table><tr><th>Sport</th><th>Head Coach</th><th>Division</th><th>Conference</th><th></th></tr>${rows}</table></div>`;

test('extracts sport-specific affiliations and coed sports without retaining staff', () => {
  const html = page(row("Men's Basketball", 'I', '<a href="/directory/orgDetail?id=827">Big Ten Conference</a>') + row('Mixed Rifle', 'I', ''));
  const result = parseSponsoredSports(html, 2027, labels, source);
  assert.equal(result.sports[0].conference.id, 827);
  assert.equal(result.sports[0].slug, 'basketball');
  assert.equal(result.sports[1].gender, 'coed');
  assert.equal(result.sports[1].conference, null);
  assert.equal(JSON.stringify(result).includes('Staff'), false);
});

test('identical repeated sport rows become one sponsorship; differing affiliation fails', () => {
  const same = row("Men's Basketball", 'I', '<a href="/directory/orgDetail?id=827">Big Ten Conference</a>');
  const result = parseSponsoredSports(page(same + same), 2027, labels, source);
  assert.equal(result.sports.length, 1);
  assert.equal(result.duplicateRows, 1);
  assert.throws(() => parseSponsoredSports(page(same + row("Men's Basketball", 'I', 'Independent')), 2027, labels, source), /Conflicting duplicate/);
});

test('fails closed on changed academic year, unknown sports, or changed table shape', () => {
  assert.throws(() => parseSponsoredSports(page(''), 2026, labels, source), /academic year/);
  assert.throws(() => parseSponsoredSports(page(row('Unknown Sport', 'I', '')), 2027, labels, source), /Unrecognized/);
  assert.throws(() => parseSponsoredSports(page('').replace('<th>Division</th>', '<th>Other</th>'), 2027, labels, source), /shape changed/);
});

test('normalizes only public NCAA-provided athletics URLs', () => {
  assert.equal(athleticsUrl('www.example.edu/athletics'), 'https://www.example.edu/athletics');
  assert.equal(athleticsUrl('http://example.edu'), 'https://example.edu/');
  assert.equal(athleticsUrl(''), null);
  for (const value of ['https://user:password@example.edu', 'http://127.0.0.1', 'file:///secret', 'https://localhost', 'https://host.internal', 'https://example.edu:8443']) {
    assert.throws(() => athleticsUrl(value));
  }
});

test('sport slugs preserve existing Big 12 conventions and distinguish genders', () => {
  assert.equal(sportSlug("Men's Basketball", 'MBB'), 'basketball');
  assert.equal(sportSlug("Women's Basketball", 'WBB'), 'womens-basketball');
  assert.equal(sportSlug("Men's Track, Indoor", 'MTI'), 'mens-track-indoor');
  assert.equal(sportSlug('Mixed Sailing', 'XSL'), 'coed-sailing');
});
