import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bandOf, dateOf } from './calendar';

// HEADWAY — the "three-train wait".
//
// The single sharpest unmodelled experience on the Underground:
//
//   The board says "2 min". The train arrives. You can't get on. Another comes.
//   You can't get on that one either. TfL calls this GOOD SERVICE, because the
//   trains ARE running to timetable. And they are. It's just that you're not on
//   any of them.
//
// No app models this, because every app reads the same signal TfL publishes:
// "are the trains running?" The right question is: "can I GET ON one?"
//
// THE DETECTION: a queue is COMPOUNDING when headways GROW while demand holds.
// Trains further apart ⇒ more people per train ⇒ trains fill ⇒ dwell times
// stretch ⇒ headways grow further. It's a positive feedback loop, and it's
// visible in the data before it's visible on any status board.
//
// WHAT WE ALREADY HAVE: every run observation records when a train arrived at a
// station. The GAPS between consecutive arrivals ARE the headways. So this needs
// NO new collection — it's derivable from data already banked, including
// everything collected so far.
//
// WHAT THIS FILE ADDS: a model of what NORMAL looks like — headway distribution
// per station, per direction, per time band. Without a baseline, "4 minutes
// between trains" means nothing. Four minutes at 3am is fine; four minutes at
// Oxford Circus at 08:30, where it's usually 100 seconds, means you are about to
// watch three full trains go past.

const BUCKET_SECONDS = 15;
const MAX_SECONDS = 900;                 // beyond 15 min it's not a headway, it's an incident
const N_BUCKETS = MAX_SECONDS / BUCKET_SECONDS;
const HALF_LIFE_DAYS = 28;
const DECAY_PER_DAY = Math.pow(0.5, 1 / HALF_LIFE_DAYS);

// s = last London date this cell was observed (see the ghost sweep in decay()).
export interface HeadwayCell { h: Record<string, number>; n: number; s?: string; }

// Staleness-guarded ghost sweep — see src/model.ts for the full rationale. A cell
// seen once and never again ages out fast; one still being observed (near-daily,
// as any shipping cell is) is never 21 days stale, so is never swept.
const GHOST_AFTER_DAYS = 21;
const GHOST_BELOW_N = 2;

export interface HeadwayModel {
  version: 1;
  updatedAt: string;
  decayedOn?: string;
  bucketSeconds: number;
  // key = `${line}|${station}|${towards}|${band}` — direction matters enormously:
  // northbound at 08:30 is a different world from southbound.
  cells: Record<string, HeadwayCell>;
}

export const emptyHeadwayModel = (): HeadwayModel => ({
  version: 1, updatedAt: new Date().toISOString(), bucketSeconds: BUCKET_SECONDS, cells: {},
});

export function loadHeadwayModel(path: string): HeadwayModel {
  if (!existsSync(path)) return emptyHeadwayModel();
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as HeadwayModel;
    return m.version === 1 && m.cells ? m : emptyHeadwayModel();
  } catch { return emptyHeadwayModel(); }
}

// Rounded projection — same reasoning as src/model.ts: full float precision was
// half the file and adds nothing a 15-second-bucket percentile can use.
const compact = (m: HeadwayModel): HeadwayModel => {
  const cells: Record<string, HeadwayCell> = {};
  for (const [key, c] of Object.entries(m.cells)) {
    const h: Record<string, number> = {};
    for (const b of Object.keys(c.h)) {
      const w = Math.round(c.h[b] * 100) / 100;
      if (w >= 0.05) h[b] = w;
    }
    if (Object.keys(h).length === 0) continue;
    cells[key] = { h, n: Math.round(c.n * 100) / 100, ...(c.s ? { s: c.s } : {}) };
  }
  return { ...m, cells };
};

export const saveHeadwayModel = (path: string, m: HeadwayModel): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(compact(m)));
};

const bucketOf = (sec: number) =>
  Math.min(N_BUCKETS - 1, Math.max(0, Math.floor(sec / BUCKET_SECONDS)));

function decay(model: HeadwayModel, today: string): void {
  if (model.decayedOn === today) return;
  const last = model.decayedOn ? Date.parse(model.decayedOn) : Date.parse(today);
  const days = Math.max(0, Math.round((Date.parse(today) - last) / 86400000));
  model.decayedOn = today;
  if (days === 0) return;
  const f = Math.pow(DECAY_PER_DAY, days);
  const nowMs = Date.parse(today);
  for (const [k, c] of Object.entries(model.cells)) {
    c.n *= f;
    for (const b of Object.keys(c.h)) {
      c.h[b] *= f;
      if (c.h[b] < 0.01) delete c.h[b];
    }
    if (!c.s) c.s = today;   // start the clock; don't sweep a cell of unknown age
    const stale = (nowMs - Date.parse(c.s)) / 86400000;
    const spent = c.n < 0.5 || Object.keys(c.h).length === 0;
    const ghost = stale >= GHOST_AFTER_DAYS && c.n < GHOST_BELOW_N;
    if (spent || ghost) delete model.cells[k];
  }
}

export interface Observation { line: string; from: string; to: string; dep: string; sec: number; }

// Derive headways from run observations: sort each (line, from→to) by departure
// time and take the gaps. Same direction, same station, consecutive trains.
export function mergeHeadways(model: HeadwayModel, obs: Observation[]): number {
  if (!obs.length) return 0;
  decay(model, dateOf(obs[0].dep));

  const groups = new Map<string, Observation[]>();
  for (const o of obs) {
    const k = `${o.line}|${o.from}|${o.to}`;
    if (!o.dep) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  let added = 0;
  for (const [k, list] of groups) {
    list.sort((a, b) => a.dep.localeCompare(b.dep));
    for (let i = 1; i < list.length; i++) {
      const gap = (Date.parse(list[i].dep) - Date.parse(list[i - 1].dep)) / 1000;
      // Under 30s is the same train double-counted; over MAX is a service gap, and
      // that's the event log's business, not the headway model's.
      if (gap < 30 || gap > MAX_SECONDS) continue;

      const [line, station, towards] = k.split('|');
      const key = `${line}|${station}|${towards}|${bandOf(list[i].dep)}`;
      const cell = model.cells[key] ?? { h: {}, n: 0 };
      const b = String(bucketOf(gap));
      cell.h[b] = (cell.h[b] ?? 0) + 1;
      cell.n++;
      cell.s = dateOf(list[i].dep);   // touched today → immune to the ghost sweep
      model.cells[key] = cell;
      added++;
    }
  }
  model.updatedAt = new Date().toISOString();
  return added;
}

export function percentile(cell: HeadwayCell, q: number): number | null {
  if (cell.n === 0) return null;
  const target = q * cell.n;
  let seen = 0;
  for (const b of Object.keys(cell.h).map(Number).sort((a, b) => a - b)) {
    seen += cell.h[String(b)];
    if (seen >= target) return Math.round((b + 0.5) * BUCKET_SECONDS);
  }
  return null;
}

// The artefact the app ships: what a NORMAL gap looks like here, at this hour,
// in this direction. The app compares the live gap against it.
export function exportForApp(model: HeadwayModel, minN = 20) {
  const out: any[] = [];
  for (const [key, cell] of Object.entries(model.cells)) {
    if (cell.n < minN) continue;
    const [line, station, towards, band] = key.split('|');
    out.push({
      l: line, s: station, d: towards, b: band,
      n: Math.round(cell.n),
      p50: percentile(cell, 0.5),
      p90: percentile(cell, 0.9),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    note: 'Normal gap between trains, by station/direction/time-band. The app '
      + 'compares the LIVE gap against p50: when the live gap is well above '
      + 'normal, a queue is compounding and you are about to watch full trains go past.',
    minObservations: minN,
    cells: out,
  };
}
