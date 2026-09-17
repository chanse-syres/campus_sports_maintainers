import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchEspnSchool, parseRecruitingInventory } from '../scripts/catalog/import-espn.mjs';
import { resolveProvider, requireProvider } from '../src/providers.mjs';
import { collectEspn, espnUrl, parseEspnNews, parseRoster, parseSchedule } from '../src/adapters/espn.mjs';
import { collectRecruiting, parseRecruiting, recruitingSourceUrl } from '../src/adapters/recruiting.mjs';

const membership = JSON.parse(readFileSync(new URL('../catalog/membership.json', import.meta.url), 'utf8'));
const registry = JSON.parse(readFileSync(new URL('../catalog/providers.json', import.meta.url), 'utf8'));
const school = membership.schools.find(value => value.ncaaId === 28);
const scope = resolveProvider(school, 'football');
const observedAt = '2026-09-17T12:00:00.000Z';

test('national registry gives every NCAA program an explicit mapping outcome', () => {
  assert.equal(Object.keys(registry.schools).length, membership.schools.length);
  for (const school of membership.schools) for (const sport of school.sports) {
    assert.ok(registry.schools[school.slug].espn[sport.slug]);
    const resolved = resolveProvider(school, sport.slug);
    assert.ok(['verified', 'noProvider'].includes(resolved.status));
    if (resolved.status === 'verified') {
      const matches = registry.leagues[sport.slug].teams.filter(team => team.id === resolved.espnId);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].location, resolved.espnName);
    }
  }
});

test('school matching distinguishes Boston institutions and rejects ambiguous team IDs', () => {
  const schools = [{name:'Boston College'}, {name:'Boston University'}];
  const teams = [{id:'103',location:'Boston College'}, {id:'104',location:'Boston University'}];
  assert.equal(matchEspnSchool(schools[0],schools,teams).espnId,'103');
  assert.equal(matchEspnSchool(schools[1],schools,teams).espnId,'104');
  assert.equal(matchEspnSchool({name:'University of X'},[{name:'University of X'}],[{id:'1',location:'X'},{id:'2',location:'X'}]).status,'unmapped');
  assert.equal(matchEspnSchool({name:'Unknown University'},[{name:'Unknown University'}],teams).status,'unmapped');
  assert.equal(matchEspnSchool({name:'Brigham Young University'},[{name:'Brigham Young University'}],[{id:'252',location:'BYU'}],['BYU']).espnId,'252');
});

test('provider scopes cannot be forged or inherited across sports', () => {
  assert.throws(()=>requireProvider({...school,ncaaId:1},'football'),/outside/);
  assert.throws(()=>requireProvider(school,'football','espn',{...scope,espnId:'1'}),/scope mismatch/);
  assert.throws(()=>espnUrl(school,'football','roster',{...scope,espnPath:'football/nfl'}),/scope mismatch/);
  assert.throws(()=>resolveProvider(school,'invented-sport'),/outside/);
  const oregon = membership.schools.find(value=>value.ncaaId===528);
  assert.notEqual(resolveProvider(oregon,'baseball').espnId,resolveProvider(oregon,'football').espnId);
});

test('ESPN collectors use verified URLs and fail closed on wrong team documents', async () => {
  let fetched;
  const data = {team:{id:scope.espnId},season:{year:2026},athletes:[{items:[{id:'7',displayName:'Example Athlete',position:{abbreviation:'QB'}}]}]};
  const result = await collectEspn({school,sport:'football',kind:'roster',provider:scope,observedAt,get:async url=>(fetched=url,JSON.stringify(data))});
  assert.equal(fetched,espnUrl(school,'football','roster'));
  assert.equal(result.records[0].name,'Example Athlete');
  assert.throws(()=>parseRoster(JSON.stringify({...data,team:{id:'999'}}),scope.espnId),/team mismatch/);
  assert.throws(()=>parseRoster(JSON.stringify({...data,athletes:{}}),scope.espnId),/Invalid roster/);
});

test('ESPN schedule retains TBD precision and rejects dates without a zone', () => {
  const event = {id:'1',date:'2026-09-17T18:00Z',name:'Example at Arizona State',timeValid:false,competitions:[{timeValid:false,competitors:[{team:{id:scope.espnId},homeAway:'home'},{team:{id:'999',displayName:'Example'}}]}]};
  const data = {team:{id:scope.espnId},events:[event]};
  assert.equal(parseSchedule(JSON.stringify(data),scope.espnId).records[0].datePrecision,'day');
  event.timeValid=true;event.competitions[0].timeValid=true;
  assert.equal(parseSchedule(JSON.stringify(data),scope.espnId).records[0].datePrecision,'instant');
  event.date='2026-09-17T18:00';
  assert.throws(()=>parseSchedule(JSON.stringify(data),scope.espnId),/Invalid event scope/);
});

test('ESPN news requires both league and team evidence and bounded publisher URLs', () => {
  const article = {headline:'Arizona State prepares for Saturday',description:'Arizona State football update',published:'2026-09-16T12:00:00Z',links:{web:{href:'https://www.espn.com/college-football/story/_/id/123/test'}},categories:[{type:'league',leagueId:scope.leagueId,league:{id:scope.leagueId}},{type:'team',teamId:scope.espnId,leagueId:scope.leagueId}],images:[]};
  const news = {header:scope.news.header,link:{href:scope.news.leagueIndexUrl},articles:[article]};
  assert.equal(parseEspnNews(JSON.stringify(news),school,'football',scope,observedAt).records.length,1);
  article.categories[1].teamId='999';
  assert.equal(parseEspnNews(JSON.stringify(news),school,'football',scope,observedAt).records.length,0);
  article.categories[1].teamId=scope.espnId;article.categories[0].league.id=1;
  assert.equal(parseEspnNews(JSON.stringify(news),school,'football',scope,observedAt).records.length,0);
  assert.throws(()=>parseEspnNews(JSON.stringify({...news,header:'NFL'}),school,'football',scope,observedAt),/identity mismatch/);
});

test('recruiting discovery follows only published, bounded ranking continuations', () => {
  const sourceUrl='https://247sports.com/Season/2027-football/CompositeTeamRankings/';
  const rows='<a class="rankings-page__name-link" href="/college/arizona-state/season/2027-football/commits/">Arizona State</a><a class="rankings-page__name-link" href="/season/2027-football/commits/">Missing slug</a>';
  const parsed=parseRecruitingInventory(rows,sourceUrl,2027,'football');
  assert.equal(parsed.candidates.length,1);
  assert.equal(parsed.candidates[0].recruitingSlug,'arizona-state');
  assert.equal(parsed.nextUrl,null);
  assert.throws(()=>parseRecruitingInventory(rows+'<a href="https://evil.example/">Load More</a>',sourceUrl,2027,'football'),/continuation/);
  assert.throws(()=>parseRecruitingInventory('Just a moment...',sourceUrl,2027,'football'),/invalid-recruiting-inventory/);
});

test('verified recruiting scopes reject wrong canonicals, incomplete lists, and WBB empty claims', async () => {
  const provider=resolveProvider(school,'football','247sports');
  assert.equal(provider.status,'verified');
  const url=recruitingSourceUrl(school,'football',2027);
  const empty=`<link rel="canonical" href="${url}"><h1>${provider.recruitingName} 2027 Football Commits (0)</h1><ul class="ri-page__list"><li class="ri-page__list-item ri-page__list-item--no-results">No Results for 2027 Football</li></ul>`;
  assert.equal(parseRecruiting(empty,url,school,'football',2027,observedAt).length,0);
  assert.throws(()=>parseRecruiting(empty.replace('Commits (0)','Commits (1)'),url,school,'football',2027,observedAt),/count mismatch/);
  assert.throws(()=>parseRecruiting(empty.replace('rel="canonical"','rel="untrusted"'),url,school,'football',2027,observedAt),/canonical/);
  const womenUrl=recruitingSourceUrl(school,'womens-basketball',2027);
  const women=empty.replaceAll(url,womenUrl).replaceAll('Football',"Women's Basketball");
  const result=await collectRecruiting({school,sport:'womens-basketball',year:2027,observedAt,get:async()=>women});
  assert.equal(result.records.length,0);
  assert.equal(result.emptyConfirmed,false);
});
