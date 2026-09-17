import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchool } from '../src/config.mjs';
import { classifyWebNews, newsFeedDefinitions, parseWebNews, webNewsSources } from '../src/adapters/web-news.mjs';

const at = '2026-09-17T20:00:00.000Z';
const school = await getSchool('arizona');
const football = school.sports.find(value => value.slug === 'football');
const men = school.sports.find(value => value.slug === 'basketball');
const women = school.sports.find(value => value.slug === 'womens-basketball');
const feeds = newsFeedDefinitions();
const feed = feeds.find(value => value.id === 'ncaa-football');
const cbs = feeds.find(value => value.id === 'cbs-basketball');
const si = feeds.find(value => value.id === 'si-arizona');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const rss = (definition, entries) => `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${escape(definition.feedTitle)}</title>${entries.map(entry => `<item><title>${escape(entry.title)}</title><link>${escape(entry.url ?? 'https://www.ncaa.com/news/football/fbs/article/arizona-wins')}</link><description><![CDATA[${entry.description ?? ''}]]></description><pubDate>${entry.date ?? 'Thu, 17 Sep 2026 12:00:00 GMT'}</pubDate>${entry.image ?? ''}</item>`).join('')}</channel></rss>`;

test('national feeds require school evidence and separate longer school names', async () => {
  const arizonaState = await getSchool('arizona-state');
  assert.equal(classifyWebNews({title:'Arizona State football wins opener'}, school, football, feed), false);
  assert.equal(classifyWebNews({title:'Arizona State football wins opener'}, arizonaState, arizonaState.sports.find(value=>value.slug==='football'), feed), true);
  assert.equal(classifyWebNews({title:'Arizona defeats Arizona State in football rivalry'}, school, football, feed), true);
  assert.equal(classifyWebNews({title:'Northern Arizona football wins opener'}, school, football, feed), false);
  assert.equal(classifyWebNews({title:'A football roundup from around the country'}, school, football, feed), false);
  const kansas = await getSchool('kansas');
  assert.equal(classifyWebNews({title:'Kansas State football signs top recruit'}, kansas, kansas.sports.find(value=>value.slug==='football'), feed), false);
});

test('ambiguous school acronyms and Miami do not establish national school identity', async () => {
  const usc = await getSchool('university-of-southern-california');
  const uscFootball = usc.sports.find(value=>value.slug==='football');
  assert.equal(classifyWebNews({title:'USC football wins opener'}, usc, uscFootball, feed), false);
  assert.equal(classifyWebNews({title:'USC Trojans football wins opener'}, usc, uscFootball, feed), true);
  const miami = await getSchool('university-of-miami-florida');
  assert.equal(classifyWebNews({title:'Miami Ohio football wins'}, miami, miami.sports.find(value=>value.slug==='football'), feed), false);
});

test('explicit gender outranks generic feed context and unscoped basketball stays ambiguous', () => {
  assert.equal(classifyWebNews({title:"Arizona women's basketball wins opener"}, school, men, cbs), false);
  assert.equal(classifyWebNews({title:"Arizona women's basketball wins opener"}, school, women, si), true);
  assert.equal(classifyWebNews({title:"Arizona men's basketball wins opener"}, school, men, si), true);
  assert.equal(classifyWebNews({title:'Arizona basketball wins opener'}, school, men, si), false);
  assert.equal(classifyWebNews({title:'Arizona basketball wins opener'}, school, women, si), false);
  assert.equal(classifyWebNews({title:'Arizona basketball wins opener',description:"The women's team added another victory."}, school, men, cbs), false);
  assert.equal(classifyWebNews({title:'Arizona fencing signs recruit'}, school, football, feed), false);
});

test('unrelated school feed stories, betting, and professional alumni headlines are excluded', () => {
  assert.equal(classifyWebNews({title:'Arizona football odds and best bets'}, school, football, si), false);
  assert.equal(classifyWebNews({title:'Former Arizona football star wins NFL award'}, school, football, si), false);
  assert.equal(classifyWebNews({title:'Kansas football signs another recruit'}, school, football, si), false);
  assert.equal(classifyWebNews({title:'Football adds another recruit'}, school, football, si), true);
});

test('parser enforces publisher identity and reviewed destinations without publishing bodies', () => {
  const result = parseWebNews(rss(feed, [
    {title:'Arizona football wins',description:'<b>Article context stays private to routing.</b><script>alert(1)</script>',image:'<media:content url="https://www.ncaa.com/images/arizona.jpg" medium="image"/>'},
    {title:'Arizona football transfer update',url:'https://evil.example.com/fake-story'},
    {title:'Arizona football weekly notes',url:'https://www.ncaa.com/news/notes',image:'<media:content url="https://evil.example.com/tracker.png" medium="image"/>'},
  ]), feed, school, football, at);
  assert.equal(result.records.length,2);
  assert.equal(result.records[0].imageUrl,'https://www.ncaa.com/images/arizona.jpg');
  assert.equal(result.records[1].imageUrl,null);
  assert.equal(result.emptyConfirmed,true);
  assert.ok(!JSON.stringify(result).includes('context stays private'));
  assert.throws(()=>parseWebNews(rss({...feed,feedTitle:'Imposter'},[]),feed,school,football,at),/identity mismatch/);
  assert.throws(()=>parseWebNews(rss(feed,[]),{...feed,url:'https://evil.example.com/feed'},school,football,at),/scope mismatch/);
  const forged={...feed,articleHosts:['evil.example.com']};
  assert.equal(parseWebNews(rss(feed,[{title:'Arizona football wins',url:'https://evil.example.com/article'}]),forged,school,football,at).records.length,0);
});

test('duplicates, unsafe URLs, future dates, malformed feeds, and external entities are bounded', () => {
  const result=parseWebNews(rss(feed,[{title:'Arizona football wins'},{title:'Arizona football wins'},
    {title:'Arizona football signed link',url:'https://www.ncaa.com/article?token=private'},
    {title:'Arizona football future',url:'https://www.ncaa.com/future',date:'Fri, 17 Sep 2027 12:00:00 GMT'},
  ]),feed,school,football,at);
  assert.equal(result.records.length,1);
  assert.throws(()=>parseWebNews('<!DOCTYPE rss>'+rss(feed,[]),feed,school,football,at),/Invalid feed/);
  assert.throws(()=>parseWebNews(rss(feed,Array(201).fill({title:'Arizona football wins'})),feed,school,football,at),/budget/);
  assert.throws(()=>webNewsSources({...school,ncaaId:123456},football),/catalog/);
});

test('verified Atom feeds parse bounded metadata and respect school scope', () => {
  const local=feeds.find(value=>value.id==='az-desert-swarm');
  const xml=`<feed xmlns="http://www.w3.org/2005/Atom"><title>${escape(local.feedTitle)}</title><entry><title>Arizona football wins opener</title><link rel="alternate" href="https://www.azdesertswarm.com/football/wins"/><published>2026-09-17T12:00:00Z</published><summary>Football roundup</summary></entry></feed>`;
  const result=parseWebNews(xml,local,school,football,at);
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].publishedAtPrecision,'instant');
});

test('shared championship feeds do not infer gender from the requested output', async()=>{
  const catalog=await import('../src/config.mjs').then(value=>value.listSchools());
  const fencingSchool=catalog.find(value=>value.sports.some(program=>program.slug==='mens-fencing')&&value.sports.some(program=>program.slug==='womens-fencing'));
  const fencing=fencingSchool.sports.find(value=>value.slug==='mens-fencing');
  const definition=feeds.find(value=>value.id==='ncaa-mens-fencing-nc');
  assert.equal(classifyWebNews({title:`${fencingSchool.name} wins fencing title`},fencingSchool,fencing,definition),false);
  assert.equal(classifyWebNews({title:`${fencingSchool.name} wins men's fencing title`},fencingSchool,fencing,definition),true);
});
