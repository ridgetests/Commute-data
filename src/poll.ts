import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toStates, diff, type LineState } from './events';
import { RunTracker, toPredictions } from './runtimes';
import { toCrowdSample, shouldRecord, CROWD_STATIONS, type CrowdRecord } from './crowding';
import { putRaw, sinkConfigured } from './sink';
import { loadModel, mergeObservations, saveModel, exportForApp } from './model';

// One long-running collector. GitHub Actions caps a job at 6 hours, so we run four
// a day, each polling for ~5h50m at 60-second cadence. That sidesteps GitHub's
// unreliable short-interval cron and gives continuous minute resolution — free,
// on a public repo.

const KEY = process.env.TFL_APP_KEY;
const MODES = process.env.MODES ?? 'tube,dlr,overground,elizabeth-line';
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 340); // 5h40m, safe margin
const INTERVAL_MS = 60_000;

const DATA = join(process.cwd(), 'data');
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const write = (kind: string, rows: unknown[]) => {
  if (!rows.length) return;
  const dir = join(DATA, kind);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${day()}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

async function get(path: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.tfl.gov.uk${path}${sep}app_key=${KEY}`);
  if (!res.ok) throw new Error(`TfL ${res.status} ${path}`);
  return res.json();
}

async function main() {
  if (!KEY) { console.error('Set TFL_APP_KEY'); process.exit(1); }

  const lines: any[] = await get(`/Line/Mode/${MODES}`);
  const lineIds: string[] = lines.map((l) => l.id);
  console.log(`Collecting ${lineIds.length} lines for ${RUN_MINUTES} min at 60s cadence.`);

  const prev = new Map<string, LineState>();
  const tracker = new RunTracker();
  const deadline = Date.now() + RUN_MINUTES * 60_000;
  let polls = 0, events = 0, runs = 0, plats = 0, crowds = 0;
  const rawRuns: any[] = [];
  // Crowding moves slowly; TfL's own live feed updates every 5 min. Match it.
  const CROWD_EVERY = Number(process.env.CROWD_EVERY_POLLS ?? 5);

  while (Date.now() < deadline) {
    const started = Date.now();
    try {
      // 1) Status → change events only. detail=true gives affectedRoutes/Stops.
      const raw = await get(`/Line/Mode/${MODES}/Status?detail=true`);
      const states = toStates(raw);
      const changes = diff(prev, states, new Date());
      if (changes.length) {
        write('events', changes);
        events += changes.length;
        for (const c of changes) {
          console.log(`  ${c.t} ${c.line}: ${c.from ?? '–'}→${c.to} (${c.cause})` +
            `${c.segments.length ? ` [${c.segments.join('; ')}]` : ''}`);
        }
      }
      for (const s of states) prev.set(s.line, s);

      // 2) Arrivals → observed run times + platform/direction history.
      const preds = [];
      for (const id of lineIds) {
        try { preds.push(...toPredictions(await get(`/Line/${id}/Arrivals`))); }
        catch (e) { /* one line failing shouldn't kill the poll */ }
      }
      const out = tracker.ingest(preds);
      // RAW RUN TIMES NO LONGER GO INTO GIT. They accumulate in memory for this
      // job, then: the MODEL (histograms) is merged into the repo, and the RAW is
      // pushed to object storage. Git is not a time-series database, and raw
      // movements would strangle the repo within months — permanently, because
      // git history can't be deleted your way out of.
      rawRuns.push(...out.runs);
      write('platforms', out.platforms);
      runs += out.runs.length;
      plats += out.platforms.length;

      // 3) Crowding — but ONLY the rows that tell us something (see crowding.ts).
      //    On a normal day live crowding is just the historical pattern playing
      //    out, and TfL already publishes that. What nobody has is how the crowd
      //    behaves WHEN THINGS BREAK — where it goes, which stations become
      //    unbearable, how long the surge takes to clear. That cannot be
      //    recovered retrospectively, and it is exactly the moment this app
      //    exists for: if we send everyone via Clapham Junction, Clapham Junction
      //    becomes the new crush.
      if (polls % CROWD_EVERY === 0) {
        const disrupted = [...prev.values()]
          .filter((s) => s.sev < 10)
          .map((s) => s.line);
        const rows: CrowdRecord[] = [];
        for (const st of CROWD_STATIONS) {
          try {
            const sample = toCrowdSample(await get(`/crowding/${st}/Live`), st, new Date());
            if (sample && shouldRecord(sample, disrupted)) {
              rows.push({ ...sample, disruptedLines: disrupted.length ? disrupted : undefined });
            }
          } catch (e) {
            // A few stations have no crowding data (Kensington Olympia,
            // Heathrow T5, Willesden Junction; Monument folds into Bank).
          }
        }
        if (rows.length) { write('crowding', rows); crowds += rows.length; }
      }

      polls++;
      if (polls % 30 === 0) {
        console.log(`[${polls} polls] ${events} events · ${runs} run times · ` +
          `${plats} platforms · ${crowds} crowding`);
      }
    } catch (e) {
      console.error('poll failed:', (e as Error).message);
    }

    const wait = INTERVAL_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  // ---- MODEL: histograms into git. Bounded, and gets BETTER not BIGGER. ----
  const modelPath = join(process.cwd(), 'data', 'model', 'runtimes.json');
  const model = loadModel(modelPath);
  const added = mergeObservations(model, rawRuns);
  saveModel(modelPath, model);

  // The artefact the app ships: p50 / p90 per segment per time band.
  const appPath = join(process.cwd(), 'data', 'model', 'app-runtimes.json');
  writeFileSync(appPath, JSON.stringify(exportForApp(model)));

  const cells = Object.keys(model.cells).length;
  console.log(`\nModel: +${added} observations → ${cells} segment×band cells`);

  // ---- RAW: cold archive, object storage, never git. ----
  const key = `raw/runtimes/${new Date().toISOString().slice(0, 13)}.jsonl.gz`;
  const r = await putRaw(key, rawRuns);
  console.log(`Raw: ${(r.bytes / 1e6).toFixed(2)} MB → ${r.where}`);
  if (!sinkConfigured()) {
    console.log('  ⚠️  Set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET');
    console.log('     to keep the raw archive. The model is safe either way.');
  }

  console.log(`\nDone. ${polls} polls · ${events} events · ${runs} run times · ` +
    `${plats} platforms · ${crowds} crowding rows`);
}

main();
