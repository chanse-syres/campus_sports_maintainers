import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSchools, listConferences, getSchool } from '../src/config.mjs';
import { maintainSchool } from '../src/maintainer.mjs';
import { validateSnapshot } from '../src/validate.mjs';
import { refreshDataset } from '../src/dataset.mjs';
import { refreshNews, mergeNews } from '../src/news.mjs';
import { SourceError, isPublicAddress, assertAllowedUrl, fetchSourceText } from '../src/network.mjs';
import { safeUrl, assertPublicValue } from '../src/normalize.mjs';
import { run } from '../src/cli.mjs';

const at='2026-09-17T00:00:00.000Z',before='2026-09-16T00:00:00.000Z';
const blocked=async()=>{throw new SourceError('http-403');};
const emptySources={schemaVersion:1,schools:{}};

test('every NCAA program executes through the same validated engine when sources fail',async()=>{
  const schools=await listSchools();let count=0;
  for(const school of schools) {
    const snapshot=await maintainSchool(school.slug,{now:at,get:blocked,sources:emptySources});
    count+=Object.keys(snapshot.sports).length;
    assert.equal(snapshot.school.ncaaId,String(school.ncaaId));
    for(const program of Object.values(snapshot.sports))for(const name of ['news','roster','schedule','recruitingAnnouncements','recruitingBoard','recruitingOffers']){
      assert.equal(program[name].status,'unavailable');assert.equal(program[name].lastSuccessAt,null);
    }
  }
  assert.equal(schools.length,365);assert.equal(count,7080);assert.equal((await listConferences()).length,32);
});

test('schema rejects cross-school, cross-sport, and credential-bearing snapshots',async()=>{
  const snapshot=await maintainSchool('arizona',{now:at,get:blocked,sources:emptySources});
  const wrong=structuredClone(snapshot);wrong.school.ncaaId='999';
  await assert.rejects(validateSnapshot(wrong),/identity mismatch/);
  const missing=structuredClone(snapshot);delete missing.sports.football;
  await assert.rejects(validateSnapshot(missing),/inventory mismatch/);
  const secret=structuredClone(snapshot);secret.school.name='Bearer '+ 'a'.repeat(25);
  await assert.rejects(validateSnapshot(secret),/Credential/);
});

test('failure retains only data from the exact original source and never advances success time',async()=>{
  const prior={status:'ok',lastAttemptAt:before,lastSuccessAt:before,sourceUrl:'https://example.com/feed',season:'2026',reason:null,records:[{id:'1'}]};
  const result=await refreshDataset({at,sourceUrl:prior.sourceUrl,prior,get:blocked,parse:()=>{throw Error('not called');}});
  assert.equal(result.status,'stale');assert.equal(result.lastSuccessAt,before);assert.equal(result.reason,'http-403');
  const foreign=await refreshDataset({at,sourceUrl:'https://other.example.com/feed',prior,get:blocked});
  assert.equal(foreign.status,'unavailable');assert.deepEqual(foreign.records,[]);
  const empty=await refreshDataset({at,sourceUrl:prior.sourceUrl,prior,collect:async()=>({records:[]})});
  assert.equal(empty.status,'stale');
});

test('news keeps photos, deduplicates tracking links, and exposes individual source failures',async()=>{
  const school={slug:'arizona'},sport={slug:'football'},url='https://example.com/feed';
  const record={id:'old',title:'Arizona wins',url:'https://example.com/news/win?utm_source=feed',publishedAt:before,publishedAtPrecision:'instant',imageUrl:'https://example.com/photo.jpg',imageAlt:null,publisher:'Example',discoverySourceUrl:url};
  assert.equal(mergeNews([record],[{...record,imageUrl:null,url:'https://example.com/news/win'}],school,sport)[0].imageUrl,record.imageUrl);
  const data=await refreshNews({school,sport,at,get:blocked,sources:[{url,collect:async()=>({records:[record]})},{url:'https://other.example.com/feed',collect:blocked}]});
  assert.equal(data.status,'stale');assert.equal(data.records.length,1);assert.equal(data.sources[1].reason,'http-403');
});

test('public network policy rejects internal destinations, URL credentials, and signed links',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(isPublicAddress(address),false);
  assert.equal(isPublicAddress('1.1.1.1'),true);
  for(const url of ['http://example.com','https://user:pass@example.com','https://127.0.0.1','https://localhost','https://example.com/?token=secret','https://example.com/?X-Amz-Signature=abc'])assert.equal(safeUrl(url),null);
  assert.throws(()=>assertAllowedUrl('https://example.com.evil.com', ['example.com']),/destination-not-allowed/);
  assert.throws(()=>assertPublicValue('C:\\Users\\someone\\secret'),/Local user path/);
});

test('unconfirmed empty news refresh cannot make retained history look freshly observed',async()=>{
  const sourceUrl='https://example.com/feed',school={slug:'arizona'},sport={slug:'football'};
  const record={id:'x',title:'Arizona wins',url:'https://example.com/news/win',publishedAt:before,publishedAtPrecision:'instant',imageUrl:null,imageAlt:null,publisher:'Example',discoverySourceUrl:sourceUrl};
  const previous={records:[record],sources:[{sourceUrl,status:'ok',lastAttemptAt:before,lastSuccessAt:before,reason:null,recordCount:1}]};
  const result=await refreshNews({school,sport,at,previous,sources:[{url:sourceUrl,collect:async()=>({records:[]})}]});
  assert.equal(result.status,'stale');assert.equal(result.lastSuccessAt,before);assert.equal(result.records.length,1);assert.equal(result.sources[0].reason,'unexpected-empty-source');
  const confirmed=await refreshNews({school,sport,at,previous,sources:[{url:sourceUrl,collect:async()=>({records:[],emptyConfirmed:true})}]});
  assert.equal(confirmed.status,'ok');assert.equal(confirmed.lastSuccessAt,at);assert.equal(confirmed.records.length,1);
});

test('future-dated official article metadata cannot displace real recent news',async()=>{
  const url='https://example.com/feed';
  const record={id:'x',title:'Real news',url:'https://example.com/news/real',publishedAt:before,publishedAtPrecision:'instant',imageUrl:null,imageAlt:null,publisher:'Example',discoverySourceUrl:url};
  const data=await refreshNews({school:{slug:'arizona'},sport:{slug:'football'},at,sources:[{url,collect:async()=>({records:[record,{...record,id:'future',title:'Future',url:'https://example.com/news/future',publishedAt:'2099-01-01T00:00:00.000Z'}]})}]});
  assert.equal(data.records.length,1);assert.equal(data.records[0].title,'Real news');assert.equal(data.sources[0].reason,'future-article-dates-filtered');
});

test('access denials are not retried; a transient error has exactly one retry',async()=>{
  let attempts=0;
  await assert.rejects(fetchSourceText('https://example.com',{}, {request:async()=>{attempts++;throw new SourceError('http-429');},pause:async()=>{}}),/429/);
  assert.equal(attempts,1);attempts=0;
  const result=await fetchSourceText('https://example.com',{}, {request:async()=>{if(++attempts===1)throw new SourceError('http-503');return 'ok';},pause:async()=>{}});
  assert.equal(result,'ok');assert.equal(attempts,2);
});

test('CLI creates a complete conference manifest and keeps previews out of published paths',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'national-maintainer-'));
  try {
    const conference=(await listConferences()).find(c=>c.slug==='ivy-league')??(await listConferences())[0];
    const maintain=(slug,options)=>maintainSchool(slug,{...options,get:blocked,sources:emptySources});
    await run(['--conference',conference.slug,'--output',root],{maintain,log:()=>{}});
    const manifest=JSON.parse(await readFile(path.join(root,'v1','conferences',conference.slug,'manifest.json'),'utf8'));
    assert.equal(manifest.schools.length,(await listSchools(conference.slug)).length);
    assert.ok(manifest.schools.every(s=>s.sha256.length===64&&s.bytes>0));
    await run(['--school','arizona','--sport','football','--output',root],{maintain,log:()=>{}});
    const preview=JSON.parse(await readFile(path.join(root,'preview','arizona','football.json'),'utf8'));
    assert.deepEqual(Object.keys(preview.sports),['football']);
    await assert.rejects(run(['--school','arizona','--sport','made-up','--output',root],{maintain,log:()=>{}}),/does not sponsor/);
  } finally {await rm(root,{recursive:true,force:true});}
});
