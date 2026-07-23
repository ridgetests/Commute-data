import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RAIL_BASE, DEFAULT_CRS, toServices, diffServices,
  type Service, type RailChange,
} from './rail';
import {
  loadPlatformModel, mergePlatforms, savePlatformModel, predictions, benchmark,
} from './platformModel';
import { putRaw, sinkConfigured } from './sink';
import { refreshBankHolidays } from './calendar';

// Darwin collector. Same shape as the TfL one: a long-running job that polls
// often and writes only when something CHANGES.
//
// Cadence: every 60 seconds. Platform allocations appear suddenly and close to
// departure, so polling slowly would blur the exact thing we're trying to
// measure — WHEN Darwin announced it.
//
// Call budget: ~20 stations × 60 polls/hour = 1,200 calls/hour, ~29k/day. Darwin
// on the open tier allows far more than this (the SOAP tier was 5M per 4-week
// period). Comfortable.

const KEY = process.env.RAIL_API_KEY ?? '';
const MINUTES = Number(process.env.RUN_MINUTES ?? 55);
const INTERVAL = Number(process.env.POLL_SECONDS ?? 60) * 1000;
const STATIONS = (process.env.RAIL_CRS ?? DEFAULT_CRS.join(','))
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function board(crs: string): Promise<any> {
  const res = await fetch(`${RAIL_BASE}/GetDepBoardWithDetails/${crs}`, {
    headers: { 'x-apikey': KEY },
  });
  if (!res.ok) throw new Error(`${crs}: HTTP ${res.status}`);
  return res.json();
}

const write = (dir: string, rows: unknown[]) => {
  if (!rows.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = join(process.cwd(), 'data', dir);
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, `${day}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

async function main() {
  if (!KEY) {
    console.error('Set RAIL_API_KEY — the CONSUMER KEY from the Rail Data');
    console.error('Marketplace product’s "Specification" tab (not the secret).');
    process.exit(1);
  }

  console.log(`Darwin: watching ${STATIONS.length} stations for ${MINUTES} min ` +
    `at ${INTERVAL / 1000}s cadence.`);

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
        if (failures <= 3) console.log(`  ! ${(e as Error).message}`);
      }
    }

    if (batch.length) {
      write('rail', batch);
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
    JSON.stringify({ generatedAt: new Date().toISOString(), benchmark: bench,
      predictions: predictions(model).slice(0, 2000) }),
  );

  // ---- RAW: cold archive. ----
  const key = `raw/rail/${new Date().toISOString().slice(0, 13)}.jsonl.gz`;
  const r = await putRaw(key, allChanges);

  console.log(`\nDone. ${polls} polls · ${changes} changes · ` +
    `${platformsSeen} platform announcements · ${failures} failures`);
  console.log(`Model: +${added} observations → ${Object.keys(model.cells).length} services`);
  console.log(`  ${bench.confident} of ${bench.servicesModelled} predictable at ≥80% confidence`);
  if (bench.darwinMedianLeadMin !== null) {
    console.log(`  📡 Darwin announces the platform ~${bench.darwinMedianLeadMin} min ` +
      `before departure. That's the number to beat.`);
  }
  console.log(`Raw: ${(r.bytes / 1e6).toFixed(2)} MB → ${r.where}`);
  if (!sinkConfigured()) console.log('  ⚠️  R2 not set — raw discarded, model is safe.');
}

main().catch((e) => { console.error(e); process.exit(1); });
