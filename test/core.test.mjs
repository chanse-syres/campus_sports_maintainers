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
  assert.equal(mergeNews([{...record,author:'Jeff Shearer'}],[{...record,author:null}],school,sport)[0].author,'Jeff Shearer');
  assert.equal(mergeNews([{...record,metadataCheckedAt:before}],[record],school,sport)[0].metadataCheckedAt,before);
  assert.equal(mergeNews([{...record,imageAlt:'Original picture'}],[{...record,imageUrl:'https://example.com/new.jpg',imageAlt:null}],school,sport)[0].imageAlt,null);
  const data=await refreshNews({school,sport,at,get:blocked,sources:[{url,collect:async()=>({records:[record]})},{url:'https://other.example.com/feed',collect:blocked}]});
  assert.equal(data.status,'stale');assert.equal(data.records.length,1);assert.equal(data.sources[1].reason,'http-403');
});

test('metadata request budget serves the four site sports before other sponsored programs',async()=>{
  const school=await getSchool('arizona'),base=school.athleticsUrl;
  const routes=new Map(),metadata=[];
  const sports=Object.fromEntries(school.sports.map(sport=>{
    const route=sport.slug==='basketball'?'mens-basketball':sport.slug;
    const source=new URL(`/sports/${route}/archives`,base).href;
    routes.set(source,sport);
    return [sport.slug,{newsUrl:source,routes:[`/sports/${route}`],aliases:[]}];
  }));
  await maintainSchool(school.slug,{now:at,metadataBudget:4,sources:{schools:{[school.slug]:{sports}}},get:async url=>{
    const sport=routes.get(url);
    if(sport){const route=sport.slug==='basketball'?'mens-basketball':sport.slug;return `<script>var obj = ${JSON.stringify({type:'stories',data:[{story_headline:'Season preview',story_path:`/news/2026/9/16/${route}-preview`,story_postdate:'2026-09-16',sport_title:sport.slug==='basketball'?"Men's Basketball":sport.name}]})};</script>`;}
    if(url.includes('/news/2026/')){metadata.push(url);return '<h1>Season preview</h1>';}
    throw new SourceError('http-403');
  }});
  assert.equal(metadata.length,4);
  assert.deepEqual(new Set(metadata.map(url=>new URL(url).pathname.split('/').at(-1))),new Set(['mens-basketball-preview','womens-basketball-preview','baseball-preview','football-preview']));
});

test('maintainer enriches retained archive stories after they leave the current source index',async()=>{
  const school=await getSchool('arizona'),source=new URL('/sports/football/archives',school.athleticsUrl).href;
  const oldUrl=new URL('/news/2026/9/15/football-archive-story',school.athleticsUrl).href;
  const sources={schools:{[school.slug]:{sports:{football:{newsUrl:source,routes:['/sports/football'],aliases:[]}}}}};
  const index=story=>`<script>var obj = ${JSON.stringify({type:'stories',data:[{sport_title:'Football',...story}]})};</script>`;
  const previous=await maintainSchool(school.slug,{now:before,metadataBudget:0,sources,get:async url=>{
    if(url===source)return index({story_headline:'Archived story',story_path:oldUrl,story_postdate:'2026-09-15'});
    throw new SourceError('http-403');
  }});
  const calls=[];
  const current=await maintainSchool(school.slug,{now:at,previous,sport:'football',metadataBudget:1,sources,get:async url=>{
    if(url===source)return index({story_headline:'New story',story_path:'/news/2026/9/16/football-new-story',story_postdate:'2026-09-16',story_image:'https://example.com/new.jpg',story_byline:'Known Author'});
    if(url===oldUrl){calls.push(url);return '<h1>Archived story</h1><meta property="og:image" content="https://example.com/archive.jpg"><meta name="author" content="Archive Writer">';}
    throw new SourceError('http-403');
  }});
  assert.deepEqual(calls,[oldUrl]);
  const retained=current.sports.football.news.records.find(x=>x.url===oldUrl);
  assert.equal(retained.imageUrl,'https://example.com/archive.jpg');assert.equal(retained.author,'Archive Writer');assert.equal(retained.metadataCheckedAt,at);
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
