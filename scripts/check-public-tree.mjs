import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicValue } from '../src/normalize.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const names=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
if(!names.length)throw new Error('No public repository files');
for(const name of names) {
  if(/(?:^|\/)(?:node_modules|output(?:-[^/]*)?|previous|reports|\.git)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|log|tmp)$/i.test(name))throw new Error(`Forbidden public file: ${name}`);
  const filename=path.join(root,name),metadata=await lstat(filename);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1)throw new Error('Public repository contains a linked file');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(filename));
  try {assertPublicValue(text);}catch {throw new Error(`Public value scan failed: ${name}`);}
  if(/(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@|\bsk_live_[a-zA-Z0-9]{20,}/.test(text))throw new Error(`Connection credential pattern rejected: ${name}`);
}
console.log(`Public tree scan passed for ${names.length} files.`);
