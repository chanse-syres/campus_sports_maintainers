import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { snapshotSchema } from './schema.mjs';
import { getSchool, loadCatalog, COLLECTIONS } from './config.mjs';
import { safeUrl, assertPublicValue } from './normalize.mjs';
const ajv = new Ajv({allErrors:false,strict:true});
const schemaCheck = ajv.compile(snapshotSchema);
export function checkPublicValues(value,key='') {
  if(Array.isArray(value)) { for(const item of value)checkPublicValues(item,key); return; }
  if(value && typeof value==='object') { for(const [k,v]of Object.entries(value))checkPublicValues(v,k);return; }
  if(typeof value!=='string')return;
  assertPublicValue(value);
  assert.ok(!/[<>\u0000-\u001f\u007f]/.test(value),'Unsafe public text');
  if(/url$/i.test(key))assert.ok(safeUrl(value),'Unsafe public URL');
  if(/At$/.test(key)||key==='date')assert.equal(new Date(value).toISOString(),value,'Noncanonical timestamp');
}
export async function validateSnapshot(snapshot,expectedSlug, {partial=false}={}) {
  if(!schemaCheck(snapshot))throw new Error(`Invalid snapshot: ${schemaCheck.errors[0].instancePath} ${schemaCheck.errors[0].keyword}`);
  checkPublicValues(snapshot);
  const school=await getSchool(expectedSlug??snapshot.school.slug);
  assert.equal(snapshot.school.slug,school.slug,'School identity mismatch');
  assert.equal(snapshot.school.ncaaId,String(school.ncaaId),'NCAA identity mismatch');
  assert.equal(snapshot.school.name,school.name,'School name mismatch');
  assert.equal(snapshot.school.athleticsUrl,school.athleticsUrl,'Athletics URL mismatch');
  assert.equal(snapshot.school.membershipSourceUrl,school.sourceUrl,'Membership provenance mismatch');
  assert.equal(snapshot.academicYear,(await loadCatalog()).academicYear,'Academic year mismatch');
  assert.equal(snapshot.conference.slug,school.conference.slug,'Primary conference mismatch');
  assert.equal(snapshot.conference.name,school.conference.name,'Conference name mismatch');
  assert.ok(Date.parse(snapshot.generatedAt)<=Date.now()+300_000,'Snapshot generation time is in the future');
  const expectedSports=school.sports.map(s=>s.slug).sort();
  if(!partial)assert.deepEqual(Object.keys(snapshot.sports).sort(),expectedSports,'Sport inventory mismatch');
  for(const [slug,program]of Object.entries(snapshot.sports)) {
    const registered=school.sports.find(s=>s.slug===slug);
    assert.ok(registered,'Unregistered sport');
    assert.equal(program.code,registered.code,'Sport code mismatch');
    assert.equal(program.name,registered.name,'Sport name mismatch');
    assert.equal(program.gender,registered.gender,'Sport gender mismatch');
    assert.equal(program.conference.slug,registered.conference.slug,'Sport conference mismatch');
    assert.equal(program.conference.name,registered.conference.name,'Sport conference name mismatch');
    for(const kind of COLLECTIONS) {
      const data=program[kind];
      assert.ok(data.status!=='unsupported','Registered sports cannot be unsupported');
      if(data.status==='unavailable')assert.ok(!data.records.length&&!data.lastSuccessAt,'Unavailable dataset claims success');
      else assert.ok(data.lastSuccessAt&&data.sourceUrl,'Successful dataset lacks provenance');
      if(data.status==='ok')assert.ok(data.records.length,'Empty dataset claims records');
      if(data.status==='empty')assert.equal(data.records.length,0,'Empty dataset contains records');
      assert.ok(Date.parse(data.lastAttemptAt)<=Date.parse(snapshot.generatedAt),'Attempt exceeds snapshot');
      if(data.lastSuccessAt)assert.ok(Date.parse(data.lastSuccessAt)<=Date.parse(data.lastAttemptAt),'Success exceeds attempt');
      assert.equal(new Set(data.records.map(r=>r.id)).size,data.records.length,'Duplicate record identity');
      if(kind==='news') {
        const sources=new Map(data.sources.map(s=>[s.sourceUrl,s]));
        assert.equal(sources.size,data.sources.length,'Duplicate sources');
        const provenanceCounts=new Map();
        for(const record of data.records) {
          const source=sources.get(record.discoverySourceUrl);
          assert.ok(source,'Missing news provenance');
          assert.ok(['ok','stale'].includes(source.status),'News record claims an unsuccessful or empty source');
          provenanceCounts.set(record.discoverySourceUrl,(provenanceCounts.get(record.discoverySourceUrl)??0)+1);
        }
        for(const source of sources.values()) {
          assert.ok(Date.parse(source.lastAttemptAt)<=Date.parse(data.lastAttemptAt),'Source attempt exceeds collection');
          if(source.status==='unavailable')assert.ok(!source.lastSuccessAt&&!source.recordCount,'Unavailable source claims success');
          else assert.ok(source.lastSuccessAt&&Date.parse(source.lastSuccessAt)<=Date.parse(source.lastAttemptAt),'Invalid source success');
          if(source.status==='empty')assert.equal(source.recordCount,0,'Empty source claims records');
          if(source.status==='ok')assert.ok(source.recordCount>0,'Successful nonempty source lacks records');
          assert.ok(source.recordCount>=(provenanceCounts.get(source.sourceUrl)??0),'News provenance exceeds source record count');
          if(['ok','empty'].includes(data.status))assert.ok(!['stale','unavailable'].includes(source.status),'Source failure hidden');
        }
        const successes=data.sources.filter(source=>source.lastSuccessAt);
        const degraded=data.sources.some(source=>['stale','unavailable'].includes(source.status));
        const expectedStatus=!successes.length?'unavailable':degraded?'stale':data.records.length?'ok':'empty';
        assert.equal(data.status,expectedStatus,'News collection status differs from source health');
        assert.equal(data.lastSuccessAt,successes.map(source=>source.lastSuccessAt).sort()[0]??null,'News success time differs from source health');
        assert.equal(data.sourceUrl,data.sources[0]?.sourceUrl??null,'News primary source differs from source health');
      }
      for(const record of data.records) {
        if('publishedAtPrecision'in record)assert.equal(record.publishedAt===null,record.publishedAtPrecision==='unknown','Publication precision mismatch');
        if(kind==='recruitingBoard'||kind==='recruitingOffers') {
          assert.equal(record.schoolId,school.slug);assert.equal(record.sport,slug);assert.equal(String(record.classYear),data.season);
          if(kind==='recruitingOffers')assert.equal(record.status,'offered');
          assert.ok(Date.parse(record.updatedAt)<=Date.parse(data.lastSuccessAt));
        }
      }
    }
  }
  return snapshot;
}
