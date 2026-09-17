import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { safeUrl } from './normalize.mjs';

export class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function assertAllowedUrl(value, allowedHosts) {
  const normalized = safeUrl(value);
  if (!normalized || !allowedHosts.includes(new URL(normalized).hostname)) throw new SourceError('destination-not-allowed');
  return new URL(normalized);
}

export function readSourceBody(res,maxBytes) {
  return new Promise((resolve,reject)=>{
    const encoding=res.headers['content-encoding']?.toLowerCase();
    if(encoding&&!['identity','gzip','deflate','br'].includes(encoding)){res.destroy();reject(new SourceError('unexpected-encoding'));return;}
    if(Number(res.headers['content-length'])>maxBytes){res.destroy();reject(new SourceError('response-too-large'));return;}
    const chunks=[];let bytes=0,wireBytes=0;
    const stream=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():res;
    const stop=code=>{res.destroy();if(stream!==res)stream.destroy();reject(new SourceError(code));};
    // Bound both wire and decoded bytes, including compressed responses from
    // servers which ignore Accept-Encoding: identity.
    if(stream!==res) {
      res.on('data',chunk=>{wireBytes+=chunk.length;if(wireBytes>maxBytes)stop('response-too-large');});
      stream.on('error',()=>stop('invalid-compressed-response'));
      res.pipe(stream);
    }
    stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)stop('response-too-large');else chunks.push(chunk);});
    res.on('error',reject);
    stream.on('end',()=>{
      if(!bytes){reject(new SourceError('empty-response'));return;}
      try{resolve(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
      catch{reject(new SourceError('invalid-utf8'));}
    });
  });
}

// Retry transient transport/server failures once. Access denials and rate limits
// are returned immediately and never trigger alternative endpoints or proxies.
export async function fetchSourceText(value, options, { request = fetchText, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  try { return await request(value, options); } catch (error) {
    if (!(error instanceof SourceError) || !['timeout', 'network-error', 'http-502', 'http-503', 'http-504'].includes(error.code)) throw error;
    await pause(1000);
    return request(value, options);
  }
}

// DNS is resolved once, checked, and pinned into the TLS connection lookup. No proxies or cookies.
export async function fetchText(value, { allowedHosts, maxBytes = 4_000_000, timeoutMs = 20_000, redirects = 2 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new SourceError('timeout')), { once: true }));
  try {
    return await Promise.race([request(value, redirects), aborted]);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(controller.signal.aborted ? 'timeout' : 'network-error');
  } finally { clearTimeout(timeout); }

  async function request(destination, remaining) {
    const url = assertAllowedUrl(destination, allowedHosts);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new SourceError('non-public-address');
    controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'CampusSportsHQ-Maintainer/1.0 (+https://github.com/chanse-syres/campus_sports_maintainers)', Accept: 'application/json,text/html,application/xml,text/xml', 'Accept-Encoding': 'identity' },
        lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (!remaining || !res.headers.location) return reject(new SourceError('redirect-limit'));
          try { resolve(request(new URL(res.headers.location, url).href, remaining - 1)); } catch { reject(new SourceError('invalid-redirect')); }
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); reject(new SourceError(`http-${res.statusCode}`)); return; }
        if (!/\b(json|html|xml|plain)\b/i.test(res.headers['content-type'] || '')) { res.destroy(); reject(new SourceError('invalid-content-type')); return; }
        resolve(readSourceBody(res,maxBytes));
      });
      req.on('error', reject);
    });
  }
}
