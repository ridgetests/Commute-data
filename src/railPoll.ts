// RAIL COLLECTOR — polls Darwin departure boards for the monitored stations
// and keeps three things: the raw change log, the platform model, and (new)
// an ON-DISK event log that the punctuality model rebuilds from.
//
// One long job, not many short ones: Darwin allowance is finite and the
// platform story only makes sense observed continuously — the announcement
// moment IS the data.
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { board, toServices, diffServices, type RailChange, type Service } from './rail';
import {
  loadPlatformModel, mergePlatforms, savePlatformModel, predictions, benchmark,
} from './platformModel';
import { refreshBankHolidays } from './calendar';

// The stations we watch. Termini + the busy interchanges where platform
// knowledge pays. Override with CRS env (comma-separated) for experiments.
const DEFAULT_CRS = [
  'WAT', 'VIC', 'LST', 'PAD', 'KGX', 'EUS', 'STP', 'CHX', 'CST', 'FST',
  'LBG', 'MYB', 'BFR', 'CLJ', 'ECR', 'SRA', 'WIM', 'SUR', 'RMD', 'VXH',
];
const STATIONS = (process.env.CRS ?? DEFAULT_CRS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const MINUTES = Number(process.env.RUN_MINUTES ?? 340);
const INTERVAL = Number(process.env.POLL_SECONDS ?? 60) * 1000;

// Raw tier: everything we saw, for R2. Bounded models go to git; raw is the
// archaeology layer.
//
// INLINED 23 Jul, after an outage this file must remember: an edit imported
// these two helpers from a './r2' module that never existed, and every rail
// run died in 15 seconds until it was caught — zero collection, zero log.
// They live HERE now; this file has no imports that can vanish. The R2
// upload itself is deliberately not wired (the four R2_* secrets have never
// been set on this repo) — when the R2 move happens, aws4fetch goes here,
// and until then the on-disk rail log + the models are the durable copies.
const sinkConfigured = (): boolean =>
  Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
async function putRaw(
  _kind: string, lines: string[],
): Promise<{ bytes: number; where: string }> {
  const bytes = lines.reduce((n, l) => n + l.length + 1, 0);
  return {
    bytes,
    where: sinkConfigured()
      ? 'R2 configured but upload not wired in this build — raw discarded'
      : 'R2 not configured — raw discarded (set R2_* secrets to keep it)',
  };
}

const rawBuf: string[] = [];
function write(kind: string, recs: unknown[]) {
  for (const r of recs) rawBuf.push(JSON.stringify({ kind, ...(r as object) }));
}

// THE LOG IS THE ASSET (added 20 Jul). Until now the rail events lived only
// in rawBuf and went to R2 or — with R2 unconfigured — the void, which is why
// the punctuality model starved on an empty directory. ~0.3 MB/day in git
// buys months of history; R2 remains the long-term home when it's wired.
const railDir = join(process.cwd(), 'data', 'rail');
mkdirSync(railDir, { recursive: true });
function persistRail(recs: RailChange[]) {
  if (recs.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(
    join(railDir, `${day}.jsonl`),
    recs.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bh = await refreshBankHolidays();
  console.log(`Bank holidays: ${bh.n} known${bh.ok ? '' : ' (from cache — refresh failed)'}`);

  const prev = new Map<string, Service>();
  const allChanges: RailChange[] = [];
  const endAt = Date.now() + MINUTES * 60_000;
  let polls = 0, changes = 0, platformsSeen = 0, failures = 0;

  while (Date.now() < endAt) {
    const started = Date.now();
    const now = new Date();
    const batch: RailChange[] = [];
    for (const crs of STATIONS) {
      try {
        const services = toServices(await board(crs), crs);
        const d = diffServices(prev, services, now);
        for (const c of d) {
          batch.push(c);
          if (c.platformFirstSeen) platformsSeen++;
        }
        for (const s of services) prev.set(s.serviceId, s);
      } catch (e) {
        failures++;
        if (failures <= 3) console.log(`  ! ${crs}: ${(e as Error).message}`);
      }
    }
    if (batch.length) {
      write('rail', batch);
      persistRail(batch);
      allChanges.push(...batch);
      changes += batch.length;
    }
    polls++;
    if (polls % 15 === 0) {
      console.log(`[${polls} polls] ${changes} changes · ` +
        `${platformsSeen} platform announcements`);
    }
    const wait = INTERVAL - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }

  if (changes === 0 && failures > 0) {
    console.error(`FATAL: ${failures} failures and 0 changes — the feed is dead (key or endpoint). Failing loudly.`);
    process.exit(1);
  }

  // ---- MODEL: the platform frequency table. Small, bounded, goes in git. ----
  const modelPath = join(process.cwd(), 'data', 'model', 'rail-platforms.json');
  const model = loadPlatformModel(modelPath);
  const added = mergePlatforms(model, allChanges);
  savePlatformModel(modelPath, model);
  const bench = benchmark(model);
  writeFileSync(
    join(process.cwd(), 'data', 'model', 'rail-predictions.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: 'Usual platform per service, with confidence. Darwin lead time is the number to beat.',
      darwinLeadMin: bench.darwinLeadMin,
      predictable: bench.predictable,
      total: bench.total,
      services: predictions(model, 5).slice(0, 2000),
    }),
  );

  console.log(`\nDone. ${polls} polls · ${changes} changes · ` +
    `${platformsSeen} platform announcements · ${failures} failures`);
  console.log(`Model: +${added} observations → ${bench.total} services`);
  console.log(`  ${bench.predictable} of ${bench.total} predictable at ≥80% confidence`);
  if (bench.darwinLeadMin !== null) {
    console.log(`  📡 Darwin announces the platform ~${Math.round(bench.darwinLeadMin)} min before departure. That's the number to beat.`);
  }

  const r = await putRaw('rail', rawBuf);
  console.log(`Raw: ${(r.bytes / 1e6).toFixed(2)} MB → ${r.where}`);
  if (!sinkConfigured()) {
    console.log('  ⚠️  R2 not set — raw discarded, but the model AND the on-disk rail log are safe.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
