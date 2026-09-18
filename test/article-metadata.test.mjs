import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleMetadata, enrichOfficialNews } from '../src/adapters/article-metadata.mjs';
const school={athleticsUrl:'https://athletics.example.edu/',allowedHosts:['athletics.example.edu']};
const record={title:'Season preview',url:'https://athletics.example.edu/news/2026/9/17/season-preview',imageUrl:null,imageAlt:null};
const page=(body='')=>`<link rel="canonical" href="${record.url}"><meta property="og:title" content="Season preview"><h1>Season preview</h1>${body}`;
test('matching article metadata recovers exact source photo and named byline',()=>{
 const html=page('<meta property="og:image" content="https://images.example.edu/photo.jpg"><meta property="og:image:alt" content="Team on court"><script type="application/ld+json">{"@type":"NewsArticle","headline":"Season preview","author":{"@type":"Person","name":"Jeff Shearer"}}</script>');
 assert.deepEqual(parseArticleMetadata(html,record,school),{imageUrl:'https://images.example.edu/photo.jpg',imageAlt:'Team on court',author:'Jeff Shearer'});
});
test('organization bylines remain explicit; absent byline is not the publisher',()=>{
 assert.equal(parseArticleMetadata(page('<div class="story-page__content__byline">By: Athletic Communications</div>'),record,school).author,'Athletic Communications');
 assert.equal(parseArticleMetadata(page(),record,school).author,null);
 assert.equal(parseArticleMetadata(page('<meta name="author" content="null">'),record,school).author,null);
 assert.equal(parseArticleMetadata(page('<meta name="author" content="Ann Null">'),record,school).author,'Ann Null');
});
test('Sidearm accessible page heading can be its brand while scoped h2 identifies the article',()=>{
 const html=`<link rel="canonical" href="${record.url}"><h1>Example Athletics</h1><div class="story-page__content__title-box"><h2>Season preview</h2></div><div class="story-page__content__byline">By: Athletic Communications</div>`;
 assert.equal(parseArticleMetadata(html,record,school).author,'Athletic Communications');
});
test('a reviewed paraphrased title uses the exact canonical article identity',()=>{
 const html=page('<meta property="og:type" content="article"><meta property="og:image" content="/photo.jpg">');
 assert.equal(parseArticleMetadata(html,{...record,title:'Our editorial headline'},school).imageUrl,'https://athletics.example.edu/photo.jpg');
});
test('rejects cross-article, cross-host, non-article redirects and unsigned-title metadata',()=>{
 assert.throws(()=>parseArticleMetadata(page().replace(record.url,'https://athletics.example.edu/news/other'),record,school),/identity/);
 assert.throws(()=>parseArticleMetadata(page(),{...record,url:'https://attacker.example/news'},school),/scope/);
 assert.throws(()=>parseArticleMetadata('<h1>Welcome to Athletics</h1><meta property="og:image" content="https://example.edu/logo.png">',record,school),/identity/);
 assert.throws(()=>parseArticleMetadata('x'.repeat(8_000_001),record,school),/size/);
});
test('article scoped photo fallback never selects unrelated header sponsor or roster image',()=>{
 const html=page('<header><img src="/sponsor.png"></header><div class="sidearm-story-image"><img src="/team.jpg" alt="Players"></div>');
 assert.equal(parseArticleMetadata(html,record,school).imageUrl,'https://athletics.example.edu/team.jpg');
 assert.equal(parseArticleMetadata(page('<img src="/logo.png">'),record,school).imageUrl,null);
 assert.equal(parseArticleMetadata(page('<meta property="og:image" content="https://cdn.example.edu/photo?token=secret">'),record,school).imageUrl,null);
});

test('known site branding is not an article photo, including wrapped Sidearm image URLs',()=>{
 const logo='https://images.sidearmdev.com/convert?url='+encodeURIComponent('https://cdn.example.edu/images/logos/site/site.png')+'&type=jpeg';
 assert.equal(parseArticleMetadata(page(`<meta property="og:image" content="${logo}">`),record,school).imageUrl,null);
 const result=parseArticleMetadata(page(`<meta property="og:image" content="${logo}"><div class="sidearm-story-image"><img src="/game.jpg" alt="Team on court"></div>`),record,school);
 assert.equal(result.imageUrl,'https://athletics.example.edu/game.jpg');assert.equal(result.imageAlt,'Team on court');
});

test('confirmed Fox and CBS default graphics are rejected while bylines and actual story photos survive',()=>{
 const defaults=[
  'https://a57.foxsports.com/statics.foxsports.com/static/orion/images/defaults/1294/728/story-card.jpg?ve=1&tl=1',
  'https://sportsfly.cbsistatic.com/fly-801/bundles/sportsmediacss/images/fantasy/default-article-image-large.png',
 ];
 for(const image of defaults){
  const result=parseArticleMetadata(page(`<meta property="og:image" content="${image}"><meta name="author" content="AP">`),record,school);
  assert.equal(result.imageUrl,null);assert.equal(result.imageAlt,null);assert.equal(result.author,'AP');
  const withPhoto=parseArticleMetadata(page(`<meta property="og:image" content="${image}"><div class="sidearm-story-image"><img src="/actual-game.jpg" alt="Players celebrate"></div>`),record,school);
  assert.equal(withPhoto.imageUrl,'https://athletics.example.edu/actual-game.jpg');assert.equal(withPhoto.imageAlt,'Players celebrate');
 }
 assert.equal(parseArticleMetadata(page('<meta property="og:image" content="https://a57.foxsports.com/photos/story-card.jpg">'),record,school).imageUrl,'https://a57.foxsports.com/photos/story-card.jpg');
});

test('empty or same-site homepage metadata is never used as an article image',()=>{
 for(const image of ['', '/', 'https://www.athletics.example.edu/']){
  assert.equal(parseArticleMetadata(page(`<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',headline:record.title,image})}</script>`),record,school).imageUrl,null);
 }
});

test('Bordeaux article heading photo replaces its default theme logo without selecting footer brands',()=>{
 const html=page('<meta property="og:image" content="/wp-content/themes/arkansasTheme/assets/images/ark-logo-left.png"><section class="bordeaux-article-container"><div class="article"><div class="heading"><div class="image-container"><img src="/game.jpg" alt=""></div></div></div></section><footer><img src="/sponsor.png"></footer>');
 assert.equal(parseArticleMetadata(html,record,school).imageUrl,'https://athletics.example.edu/game.jpg');
});
test('bounded enrichment preserves known metadata and tolerates optional metadata failure',async()=>{
 const records=[{...record,imageUrl:'https://cdn.example.edu/known.jpg',author:'Known Writer'},record,{...record,url:record.url+'-2'},{...record,url:'https://other.example.edu/news/1'}];let calls=0;
 const result=await enrichOfficialNews(records,school,async()=>{calls++;if(calls===2)throw Error('denied');return page('<meta name="author" content="Jane Writer"><meta property="og:image" content="/new.jpg">');},{limit:2});
 assert.equal(calls,2);assert.equal(result[0].imageUrl,records[0].imageUrl);assert.equal(result[0].author,'Known Writer');assert.equal(result[1].author,'Jane Writer');assert.equal(result[1].imageUrl,'https://athletics.example.edu/new.jpg');const {metadataCheckedAt,...failed}=result[2];assert.ok(metadataCheckedAt);assert.deepEqual(failed,records[2]);assert.deepEqual(result[3],records[3]);
});
test('new metadata never attaches a different photograph caption to an existing photo',async()=>{
 const original={...record,imageUrl:'https://cdn.example.edu/original-game.jpg'};
 const [result]=await enrichOfficialNews([original],school,async()=>page('<meta property="og:image" content="/new-portrait.jpg"><meta property="og:image:alt" content="Coach portrait">'));
 assert.equal(result.imageUrl,original.imageUrl);assert.equal(result.imageAlt,null);
});
test('OpenGraph photo never inherits the caption of a different body photo',()=>{
 const result=parseArticleMetadata(page('<meta property="og:image" content="/game.jpg"><div class="sidearm-story-image"><img src="/portrait.jpg" alt="Coach portrait"></div>'),record,school);
 assert.equal(result.imageUrl,'https://athletics.example.edu/game.jpg');assert.equal(result.imageAlt,null);
});
test('a missing photo is enriched before older uncredited metadata exhausts the budget',async()=>{
 const creditedPhoto={...record,imageUrl:'https://cdn.example.edu/game.jpg'};
 const photoGap={...record,url:record.url+'-gap',title:'Photo gap'};
 const calls=[];await enrichOfficialNews([creditedPhoto,photoGap],school,async url=>{calls.push(url);throw Error('No metadata');},{limit:1});
 assert.deepEqual(calls,[photoGap.url]);
});
test('persisted negative attempts let repeated bounded runs progress through the retained archive',async()=>{
 const rows=Array.from({length:8},(_,i)=>({...record,url:record.url+'-'+i}));
 const calls=[];const get=async url=>{calls.push(url);throw Error('No reliable metadata');};
 const first=await enrichOfficialNews(rows,school,get,{limit:3,at:'2026-09-17T00:00:00.000Z'});
 assert.deepEqual(calls,rows.slice(0,3).map(x=>x.url));calls.length=0;
 const second=await enrichOfficialNews(first,school,get,{limit:3,at:'2026-09-17T04:00:00.000Z'});
 assert.deepEqual(calls,rows.slice(3,6).map(x=>x.url));calls.length=0;
 await enrichOfficialNews(second,school,get,{limit:3,at:'2026-09-17T08:00:00.000Z'});
 assert.deepEqual(calls,rows.slice(6).map(x=>x.url));calls.length=0;
 await enrichOfficialNews(first,school,get,{limit:1,at:'2026-09-24T00:00:00.000Z'});
 // Never-attempted records still outrank expired negatives.
 assert.deepEqual(calls,[rows[3].url]);
});

test('expired photo failures do not starve never-attempted archive bylines',async()=>{
 const expiredPhotoGap={...record,metadataCheckedAt:'2026-09-10T00:00:00.000Z'};
 const untouchedByline={...record,url:record.url+'-author',imageUrl:'https://cdn.example.edu/game.jpg'};
 const calls=[];
 await enrichOfficialNews([expiredPhotoGap,untouchedByline],school,async url=>{calls.push(url);throw Error('No metadata');},{limit:1,at:'2026-09-17T00:00:00.000Z'});
 assert.deepEqual(calls,[untouchedByline.url]);
});
