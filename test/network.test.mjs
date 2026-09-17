import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { readSourceBody } from '../src/network.mjs';
const response=(body,encoding)=>{const value=Readable.from([body]);value.headers={'content-encoding':encoding,'content-length':String(body.length)};return value;};
test('compressed official pages decode within the same bounded response budget',async()=>{
  const body=Buffer.from('<html>Valid sports news</html>');
  for(const [encoding,compress]of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]])assert.equal(await readSourceBody(response(compress(body),encoding),1024),body.toString());
});
test('compression bombs, malformed encoding and invalid text cannot reach the parser',async()=>{
  await assert.rejects(readSourceBody(response(gzipSync(Buffer.alloc(100000,65)),'gzip'),1024),/response-too-large/);
  await assert.rejects(readSourceBody(response(Buffer.from('not gzip'),'gzip'),1024),/invalid-compressed-response/);
  await assert.rejects(readSourceBody(response(Buffer.from([0xff,0xfe]),'identity'),1024),/invalid-utf8/);
  await assert.rejects(readSourceBody(response(Buffer.from('abc'),'gzip, br'),1024),/unexpected-encoding/);
  await assert.rejects(readSourceBody(response(Buffer.alloc(2048),'identity'),1024),/response-too-large/);
});
