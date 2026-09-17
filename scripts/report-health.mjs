import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listSchools } from '../src/config.mjs';
import { validateSnapshot } from '../src/validate.mjs';

export function newsHealth(snapshots, now = Date.now()) {
  const programs=[],sources=new Map(),schools=[];
  for(const snapshot of snapshots) {
    let articles=0,withImages=0;
    for(const [slug,sport]of Object.entries(snapshot.sports)) {
      const news=sport.news,dated=news.records.filter(r=>r.publishedAt).map(r=>r.publishedAt).sort();
      const lastArticleAt=dated.at(-1)??null;
      const row={school:snapshot.school.slug,conference:snapshot.conference.slug,sport:slug,status:news.status,articles:news.records.length,withImages:news.records.filter(r=>r.imageUrl).length,lastSuccessAt:news.lastSuccessAt,lastArticleAt,observationOlderThan12Hours:!news.lastSuccessAt||now-Date.parse(news.lastSuccessAt)>12*3_600_000,reasons:[...new Set([news.reason,...news.sources.map(s=>s.reason)].filter(Boolean))]};
      programs.push(row);articles+=row.articles;withImages+=row.withImages;
      for(const source of news.sources) {
        const key=`${source.sourceUrl}|${source.status}|${source.reason??''}`;
        if(!sources.has(key))sources.set(key,{url:source.sourceUrl,status:source.status,reason:source.reason,programs:0});
        sources.get(key).programs++;
      }
    }
    schools.push({slug:snapshot.school.slug,articles,withImages,generatedAt:snapshot.generatedAt});
  }
  return {schemaVersion:1,observedAt:new Date(now).toISOString(),schoolCount:schools.length,programCount:programs.length,articleCount:programs.reduce((n,p)=>n+p.articles,0),photoCount:programs.reduce((n,p)=>n+p.withImages,0),statusCounts:programs.reduce((a,p)=>(a[p.status]=(a[p.status]??0)+1,a),{}),schoolsWithoutArticles:schools.filter(s=>!s.articles).map(s=>s.slug),programsWithoutArticles:programs.filter(p=>!p.articles).length,schools,programs,sourceHealth:[...sources.values()]};
}

export async function report({output='output',conference}={}) {
  const snapshots=[];
  for(const school of await listSchools(conference)) {
    const filename=path.join(path.resolve(output),'v1','conferences',school.conference.slug,'schools',`${school.slug}.json`);
    try {snapshots.push(await validateSnapshot(JSON.parse(await readFile(filename,'utf8')),school.slug));}
    catch(error){if(error.code==='ENOENT'&&!conference)continue;throw error;}
  }
  if(!snapshots.length)throw new Error('No complete school snapshots to report');
  return newsHealth(snapshots);
}

export function markdown(report) {
  const failures=report.sourceHealth.filter(s=>['stale','unavailable'].includes(s.status));
  const missing=report.programs.filter(p=>!p.articles);
  return [
    '## News collection health','',
    `${report.schoolCount} schools · ${report.programCount} programs · ${report.articleCount} article placements · ${report.photoCount} photos.`,
    '',`Program status: ${Object.entries(report.statusCounts).map(([k,v])=>`${k}: ${v}`).join(', ')}.`,
    '',`${report.schoolsWithoutArticles.length} schools and ${missing.length} programs have no articles. A successful job means the output passed validation; inspect these coverage results separately.`,
    '', '### Schools without articles','',report.schoolsWithoutArticles.join(', ')||'None.',
    '', '### Source failures','', '| Source | Status | Reason | Programs |','|---|---|---|---|',
    ...failures.slice(0,200).map(s=>`| ${s.url.replaceAll('|','%7C')} | ${s.status} | ${s.reason??''} | ${s.programs} |`),
    ...(failures.length>200?[`Only first 200 of ${failures.length} failures shown; JSON report includes all.`]:[]),
    '', 'Use original article dates to judge content age. lastSuccessAt records a feed observation, not proof that the publisher has released a new story.',''
  ].join('\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:{output:{type:'string',default:'output'},conference:{type:'string'},markdown:{type:'boolean'}}});
  const result=await report(values);console.log(values.markdown?markdown(result):JSON.stringify(result,null,2));
}
