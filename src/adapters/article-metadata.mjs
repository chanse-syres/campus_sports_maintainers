import { load } from 'cheerio';
import { cleanText, safeUrl } from '../normalize.mjs';

const MAX_BYTES=8_000_000;
const host=value=>new URL(value).hostname.replace(/^www\./,'');
const key=value=>cleanText(value,1000).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const canonical=value=>{const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_.+|fbclid|gclid)$/i.test(k))u.searchParams.delete(k);return u.href.replace('://www.', '://').replace(/\/$/,'');};
function articleImage(value,base) {
 if(typeof value!=='string'||!value.trim())return null;
 const url=safeUrl(value,base);if(!url)return null;
 const parsed=new URL(url),nested=safeUrl(parsed.searchParams.get('url'));
 if(canonical(url)===canonical(base)||(host(url)===host(base)&&parsed.pathname==='/'&&!parsed.search))return null;
 const candidates=[parsed,...(nested?[new URL(nested)]:[])];
 if(candidates.some(image=>(/(^|\.)foxsports\.com$/i.test(image.hostname)&&/\/static\/orion\/images\/defaults\/(?:\d+\/\d+\/)?story-card\.jpg$/i.test(image.pathname))||(/(^|\.)cbsistatic\.com$/i.test(image.hostname)&&/\/bundles\/sportsmediacss\/images\/fantasy\/default-article-image-large\.png$/i.test(image.pathname))))return null;
 const paths=[parsed.pathname,...(nested?[new URL(nested).pathname]:[])];
 // These observed source defaults are branding, not missing article photos.
 return paths.some(path=>/\/images\/logos\/site\/site\.(?:png|svg|jpe?g|webp)$/i.test(path)||path==='/wp-content/themes/arkansasTheme/assets/images/ark-logo-left.png')?null:url;
}
export function cleanAuthor(value) {
 if(typeof value!=='string'||value.length>4096)return null;
 const name=cleanText(value.replace(/^\s*by\s*:?\s+/i,''),300);
 return !name||/^(null|undefined)$/i.test(name)?null:name;
}
const authorValue=value=>{
 const values=Array.isArray(value)?value.slice(0,8):[value];
 const names=values.map(item=>typeof item==='string'?cleanAuthor(item):item&&['Person','Organization'].includes(item['@type'])?cleanAuthor(item.name):null).filter(Boolean);
 return names.length?cleanAuthor([...new Set(names)].join(', ')):null;
};
export function parseArticleMetadata(text,record,school) {
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('Article document exceeds size budget');
 const url=safeUrl(record.url),allowed=new Set([school.athleticsUrl,...(school.allowedHosts??[]).map(x=>`https://${x}`)].filter(Boolean).map(host));
 if(!url||!allowed.has(host(url)))throw Error('Article is outside official scope');
 const $=load(text),meta=name=>$(`meta[property="${name}"],meta[name="${name}"]`).first().attr('content');
 const declarations=$('link[rel="canonical"],meta[property="og:url"]').toArray().map(node=>safeUrl($(node).attr('href')??$(node).attr('content'),url)).filter(Boolean);
 if(declarations.some(value=>canonical(value)!==canonical(url)))throw Error('Article identity mismatch');
 const title=key(record.title),headings=$('h1,.story-page__content__title-box h2,.sidearm-story-headline').toArray().map(node=>key($(node).text()));
 const isCanonicalArticle=declarations.length>0&&meta('og:type')==='article';
 if(!title||(!isCanonicalArticle&&!headings.includes(title)&&key(meta('og:title'))!==title))throw Error('Article identity is not confirmed');
 let structuredAuthor=null,structuredImage=null;
 for(const node of $('script[type="application/ld+json"]').toArray().slice(0,30)) {
   let data;try{data=JSON.parse($(node).text());}catch{continue;}
   const nodes=Array.isArray(data)?data:data?.['@graph']??[data];
   if(!Array.isArray(nodes)||nodes.length>100)continue;
   for(const item of nodes){if(!item||!['NewsArticle','Article','BlogPosting'].includes(item['@type']))continue;
     if(item.headline&&key(item.headline)!==title)continue;
     const declared=safeUrl(typeof item.url==='string'?item.url:item.mainEntityOfPage?.['@id'],url);
     if(declared&&canonical(declared)!==canonical(url))continue;
     structuredAuthor??=authorValue(item.author);
     const image=Array.isArray(item.image)?item.image[0]:item.image;
     structuredImage??=articleImage(typeof image==='string'?image:image?.url,url);
   }
 }
 const bodyImage=$('.sidearm-story-image img,.story-page__image img,.story-page__hero img,article .entry-content > figure:first-child img,.bordeaux-article-container > .article > .heading > .image-container > img').first();
 const openGraphImage=articleImage(meta('og:image'),url),bodyImageUrl=articleImage(bodyImage.attr('data-src')??bodyImage.attr('src'),url);
 const imageUrl=openGraphImage??structuredImage??bodyImageUrl;
 const imageAlt=imageUrl?(imageUrl===openGraphImage?cleanText(meta('og:image:alt'),300)||null:null)??(imageUrl===bodyImageUrl?cleanText(bodyImage.attr('alt'),300)||null:null):null;
 const byline=$('.story-head__author,.story-page__content__byline,.sidearm-story-byline,.story-byline,[itemprop="author"]').first().text();
 return {imageUrl,imageAlt,author:structuredAuthor??cleanAuthor(meta('author'))??cleanAuthor(byline)};
}

/** Optional enrichment never replaces verified fields or turns source denial into success. */
export async function enrichOfficialNews(records,school,get,{limit=5,at=new Date().toISOString(),onResult=()=>{}}={}) {
 if(!Number.isSafeInteger(limit)||limit<0||limit>100||!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at)throw Error('Invalid metadata enrichment budget or timestamp');
 const allowed=new Set([school.athleticsUrl,...(school.allowedHosts??[]).map(x=>`https://${x}`)].filter(Boolean).map(host));
 let requests=0;const result=[...records];
 // Attempt the retained archive before retrying expired failures. Within each
 // group, missing photos take priority; stable sorting preserves recency.
 const candidates=records.map((record,index)=>({record,index})).filter(({record})=>(!record.imageUrl||!record.author)&&safeUrl(record.url)&&allowed.has(host(record.url))&&(!record.metadataCheckedAt||Date.parse(at)-Date.parse(record.metadataCheckedAt)>=7*86_400_000))
   .sort((a,b)=>Number(Boolean(a.record.metadataCheckedAt))-Number(Boolean(b.record.metadataCheckedAt))||Number(Boolean(a.record.imageUrl))-Number(Boolean(b.record.imageUrl)));
 for(const {record,index} of candidates){let value=record;
   if(requests<limit){
     requests++;
     value={...record,metadataCheckedAt:at};
     try{const metadata=parseArticleMetadata(await get(record.url),record,school);const imageUrl=record.imageUrl??metadata.imageUrl;value={...value,imageUrl,imageAlt:record.imageUrl?record.imageAlt??(record.imageUrl===metadata.imageUrl?metadata.imageAlt:null):metadata.imageAlt,author:record.author??metadata.author};onResult({url:record.url,status:'ok',imageAdded:!record.imageUrl&&Boolean(value.imageUrl),authorAdded:!record.author&&Boolean(value.author)});}
     catch(error){onResult({url:record.url,status:'unavailable',reason:error.code??error.message});}
   }
   result[index]=value;
 }
 return result;
}
