import { gzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';

// COLD STORAGE — the raw archive.
//
// WHY THIS EXISTS: git is a version control system, not a time-series database.
// It's built for small files that are edited, diffed and versioned. Raw train
// movements are the opposite: append-only, never edited, never diffed, read in
// bulk. Push them into git and they win — every version of every file stays in
// the history FOREVER, so you can't even delete your way out of it.
//
// So the split is:
//   • RAW observations  → object storage (here). The archive. Never in git.
//   • MODEL aggregates  → git. Small, bounded, and they get BETTER not BIGGER.
//
// Cloudflare R2 is the right home: 10 GB free, and — the part that matters —
// ZERO EGRESS FEES, unlike S3 where reading your own data back costs money.
// Later you can query it in place with DuckDB over Parquet without a server.
//
// FAILS SAFE, ON PURPOSE: if R2 isn't configured, or the upload fails, the run
// continues and the aggregates still get written. Losing a day of RAW archive is
// a shame. Losing the model would be a bug.

export interface SinkResult {
  ok: boolean;
  bytes: number;
  where: string;
}

const R2_ACCOUNT = process.env.R2_ACCOUNT_ID ?? '';
const R2_KEY = process.env.R2_ACCESS_KEY_ID ?? '';
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY ?? '';
const R2_BUCKET = process.env.R2_BUCKET ?? 'commute-data';

export const sinkConfigured = (): boolean =>
  Boolean(R2_ACCOUNT && R2_KEY && R2_SECRET);

// Upload newline-delimited JSON, gzipped. Roughly 10× smaller than raw, and
// object storage doesn't care about the shape.
export async function putRaw(key: string, rows: unknown[]): Promise<SinkResult> {
  if (rows.length === 0) return { ok: true, bytes: 0, where: 'nothing to write' };

  const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));

  if (!sinkConfigured()) {
    return {
      ok: false,
      bytes: body.length,
      where: 'R2 not configured — raw discarded (set R2_* secrets to keep it)',
    };
  }

  try {
    const client = new AwsClient({
      accessKeyId: R2_KEY,
      secretAccessKey: R2_SECRET,
      service: 's3',
      region: 'auto',
    });
    const url = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;
    const res = await client.fetch(url, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/gzip' },
    });
    if (!res.ok) {
      return { ok: false, bytes: body.length, where: `R2 ${res.status}: ${await res.text()}` };
    }
    return { ok: true, bytes: body.length, where: `r2://${R2_BUCKET}/${key}` };
  } catch (e) {
    // Never let the archive take the model down with it.
    return { ok: false, bytes: body.length, where: `R2 error: ${(e as Error).message}` };
  }
}
