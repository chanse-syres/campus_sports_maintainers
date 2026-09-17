import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export function cleanText(value, max = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).slice(0, 10_000).replace(/<[^>]*>/g, ' ').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function safeUrl(value, base) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return null;
    // A public link must never carry authentication or a signed access grant.
    for (const key of url.searchParams.keys()) {
      if (/^(?:access[-_]?token|api[-_]?key|authorization|auth|token|secret|password|signature|sig|x-amz-.+|x-goog-.+)$/i.test(key)) return null;
    }
    return url.href;
  } catch { return null; }
}
export function assertPublicValue(value) {
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bBearer\s+[A-Za-z0-9._-]{20,})/.test(value)) throw new Error('Credential-like value rejected');
  if (/(?:[A-Z]:[\\/]Users[\\/]|\/(?:home|Users)\/[^/\s]+\/)/i.test(value)) throw new Error('Local user path rejected');
}
export const stableId = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
export function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function uniqueById(records) {
  return [...new Map(records.map(record => [record.id, record])).values()];
}
