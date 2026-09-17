import { SourceError } from './network.mjs';

export const emptyDataset = (at, status, reason, sourceUrl = null) => ({ status, lastAttemptAt: at, lastSuccessAt: null, sourceUrl, season: null, reason, records: [] });
export async function refreshDataset({ at, sourceUrl, prior, get, parse, collect }) {
  try {
    const parsed = collect ? await collect() : await parse(await get(sourceUrl));
    if (!Array.isArray(parsed.records)) throw new Error('Invalid records');
    // An unexpectedly empty source must not erase a known collection.
    if (!parsed.records.length && prior?.records.length && parsed.emptyConfirmed !== true) throw new SourceError('unexpected-empty-source');
    return { status: parsed.records.length ? 'ok' : 'empty', lastAttemptAt: at, lastSuccessAt: at, sourceUrl, season: parsed.season ?? null, reason: parsed.reason ?? null, records: parsed.records };
  } catch (error) {
    const reason = error instanceof SourceError ? error.code : 'source-format-changed';
    if (prior?.lastSuccessAt && prior.sourceUrl === sourceUrl) return { ...prior, status: 'stale', lastAttemptAt: at, reason };
    return emptyDataset(at, 'unavailable', reason, sourceUrl);
  }
}
