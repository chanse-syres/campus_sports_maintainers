import { emptyDataset, refreshDataset } from './dataset.mjs';
import { stableId, safeUrl } from './normalize.mjs';
import { SourceError } from './network.mjs';
export const MAX_NEWS_RECORDS=1000;
function canonical(value) {
  const safe=safeUrl(value);if(!safe)throw new Error('Unsafe article URL');
  const url=new URL(safe);url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key))url.searchParams.delete(key);
  return url.href;
}
export function mergeNews(previous,current,school,sport) {
  const records=new Map();
  for(const item of [...previous,...current]) {
    const url=canonical(item.url),prior=records.get(url);
    const imageUrl=item.imageUrl??prior?.imageUrl??null;
    const imageAlt=item.imageUrl?item.imageAlt??(item.imageUrl===prior?.imageUrl?prior.imageAlt:null):prior?.imageAlt??null;
    const metadataCheckedAt=[item.metadataCheckedAt,prior?.metadataCheckedAt].filter(Boolean).sort().at(-1);
    records.set(url,{...item,url,id:stableId(school.slug,sport.slug,url),imageUrl,imageAlt,author:item.author??prior?.author??null,...(metadataCheckedAt?{metadataCheckedAt}:{})});
  }
  const titles=new Set();
  return [...records.values()].sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0)||a.url.localeCompare(b.url)).filter(item=>{
    const key=`${item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()}|${item.publishedAt?.slice(0,10)??item.url}`;
    if(titles.has(key))return false;titles.add(key);return true;
  }).slice(0,MAX_NEWS_RECORDS);
}
export async function refreshNews({school,sport,at,previous,sources,get}) {
  if(!sources.length)return {...emptyDataset(at,'unavailable','no-reviewed-news-source'),sources:[]};
  const results=[];
  for(const source of sources) {
    const priorHealth=previous?.sources.find(s=>s.sourceUrl===source.url),priorRecords=previous?.records.filter(r=>r.discoverySourceUrl===source.url)??[];
    const prior=priorHealth?{...priorHealth,season:null,records:priorRecords}:null;if(prior)delete prior.recordCount;
    const data=await refreshDataset({at,sourceUrl:source.url,prior,get,collect:async()=>{
      const parsed=await source.collect(get);
      if(!Array.isArray(parsed.records))throw new SourceError('source-format-changed');
      const records=parsed.records.filter(r=>!r.publishedAt||Date.parse(r.publishedAt)<=Date.parse(at)+86_400_000);
      if(!records.length&&priorRecords.length&&parsed.emptyConfirmed!==true)throw new SourceError('unexpected-empty-source');
      return {...parsed,reason:records.length!==parsed.records.length?'future-article-dates-filtered':parsed.reason,records:mergeNews(priorRecords,records.map(r=>({...r,discoverySourceUrl:source.url})),school,sport)};
    }});
    results.push(data);
  }
  const successes=results.filter(s=>s.lastSuccessAt),degraded=results.some(s=>['stale','unavailable'].includes(s.status));
  const records=mergeNews([],results.flatMap(s=>s.records),school,sport);
  return {...emptyDataset(at,!successes.length?'unavailable':degraded?'stale':records.length?'ok':'empty',degraded?'one-or-more-news-sources-degraded':null,sources[0].url),
    lastSuccessAt:successes.map(s=>s.lastSuccessAt).sort()[0]??null,records,
    sources:results.map(({records,season,...health})=>({...health,recordCount:records.length}))};
}
