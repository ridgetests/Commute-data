import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bandOf as calendarBand, dateOf } from './calendar';

// THE MODEL — what the app actually ships.
//
// HISTOGRAMS, NOT MEANS. This is the whole point.
//
// A mean destroys the tail. And the tail IS the product: the Constrained user —
// the one with the school pickup and the £5-a-minute late fee — does not care
// what the journey usually takes. She cares what it takes on a BAD day. That's a
// 90th percentile, and a mean cannot produce one. Neither can min/max, which are
// just the two most freakish outliers you happened to catch.
//
// A histogram gives you every percentile, forever, from a few dozen bytes.
//
// AND IT'S BOUNDED. This is the second point, and it's why the model belongs in
// git while the raw doesn't. The raw archive grows every single day, without
// limit. The model does NOT: there are only so many (segment × time-band) cells
// on the network, so the file stops growing and simply gets DENSER — more
// observations per cell, better percentiles, same size. It gets better, not
// bigger. That is exactly the shape of thing git is good at.
//
// ASSUMPTIONS, STATED:
// • 15-second buckets, capped at 20 minutes. Anything above that on a single
//   segment isn't a journey, it's an incident — and incidents are the event log's
//   job, not the run-time model's. Over-cap observations are counted in the top
//   bucket rather than discarded, so the tail stays honest.
// • Time bands are weekday/weekend × hour (UTC). British Summer Time will smear
//   this by an hour for part of the year — noted, not yet fixed.

const BUCKET_SECONDS = 15;
const MAX_SECONDS = 1200;
const N_BUCKETS = MAX_SECONDS / BUCKET_SECONDS;   // 80

export interface Cell {
  // Sparse: bucket index → count. Most cells touch only a handful of buckets.
  h: Record<string, number>;
  n: number;
  // Last London date this cell was observed. Lets a ghost (a vanish/reappear
  // artefact seen once and never again) age out fast, without touching a cell
  // that's genuinely still being seen. Optional for back-compat with older files.
  s?: string;
}

export interface RunModel {
  version: 1;
  updatedAt: string;
  bucketSeconds: number;
  // The London date of the last decay pass. Decay is applied per-day, once —
  // not per-run, or an hourly job would forget 24× faster than a daily one.
  decayedOn?: string;
  // key = `${line}|${from}|${to}|${band}`
  cells: Record<string, Cell>;
}

// EXPONENTIAL FORGETTING — the fix for drift, and it's the whole safety story.
//
// The timetable changes twice a year. Platforms get resurfaced. Engineering works
// reroute things for a month. If the model remembers everything equally forever,
// old evidence quietly poisons the new pattern — and the failure mode is the
// worst one available: CONFIDENTLY WRONG.
//
// Decay fixes it without ever needing to detect WHY things changed. Every day,
// all counts are multiplied by a factor slightly below 1, so recent evidence
// steadily outweighs old. When a pattern breaks, the old votes fade, the new ones
// take over, and — crucially — during the changeover CONFIDENCE COLLAPSES,
// because the votes are split. So the app goes SILENT rather than wrong.
//
// That is the property that matters. A model that degrades to silence is safe.
// A model that degrades to confident nonsense is a product that gets deleted.
//
// HALF_LIFE_DAYS = 28: after four weeks an observation carries half its original
// weight; after twelve, an eighth. Fast enough to adapt to a timetable change
// within a few weeks, slow enough not to be blown about by one odd Tuesday.
export const HALF_LIFE_DAYS = 28;
const DECAY_PER_DAY = Math.pow(0.5, 1 / HALF_LIFE_DAYS);   // ≈ 0.9755

// Two prune rules, and the distinction is the whole safety story.
//
// PRUNE_BELOW_N (the floor): a cell whose total weight has decayed below this is
// spent — kept low so a cell can still CLIMB toward the n≥20 it needs to ship.
// A daily prune anywhere near the shipping threshold would guillotine cells on
// their way up, so this stays tiny.
//
// The GHOST SWEEP (staleness-guarded): the file bloats not from spent cells but
// from ones seen ONCE and never again — a vehicle that vanished and reappeared,
// producing a geographically nonsensical segment that happens to pass the run
// bounds. Under decay alone these linger ~28 days (a lone observation takes that
// long to fall below the floor). The sweep removes a cell only when it is BOTH
// small (n < GHOST_BELOW_N) AND untouched for GHOST_AFTER_DAYS. The staleness
// guard is what makes it safe: any cell on a trajectory to ship is observed
// near-daily, so it is never 21 days stale, so it is never swept — proven, not
// hoped. Only genuinely abandoned cells qualify.
const PRUNE_BELOW_N = 0.5;
const GHOST_AFTER_DAYS = 21;
const GHOST_BELOW_N = 2;

export function applyDecay(model: RunModel, today: string): number {
  if (model.decayedOn === today) return 0;   // once a day, no matter how many runs

  const last = model.decayedOn ? Date.parse(model.decayedOn) : Date.parse(today);
  const days = Math.max(0, Math.round((Date.parse(today) - last) / 86400000));
  model.decayedOn = today;
  if (days === 0) return 0;

  const factor = Math.pow(DECAY_PER_DAY, days);
  const nowMs = Date.parse(today);
  let pruned = 0;

  for (const [key, cell] of Object.entries(model.cells)) {
    cell.n *= factor;
    for (const b of Object.keys(cell.h)) {
      cell.h[b] *= factor;
      if (cell.h[b] < 0.01) delete cell.h[b];
    }
    // Cells predating the last-seen field start their clock now — honest: we
    // don't know when they were last seen, so we don't sweep them yet; they
    // prove themselves ghosts by going untouched from here.
    if (!cell.s) cell.s = today;
    const staleDays = (nowMs - Date.parse(cell.s)) / 86400000;
    const spent = cell.n < PRUNE_BELOW_N || Object.keys(cell.h).length === 0;
    const ghost = staleDays >= GHOST_AFTER_DAYS && cell.n < GHOST_BELOW_N;
    if (spent || ghost) {
      delete model.cells[key];
      pruned++;
    }
  }
  return pruned;
}

// Day-type × London-local hour. Was getUTCHours(), which shifted every band by
// an hour for seven months of the year, and filed bank holidays as weekdays.
export const bandOf = calendarBand;

const bucketOf = (sec: number): number =>
  Math.min(N_BUCKETS - 1, Math.max(0, Math.floor(sec / BUCKET_SECONDS)));

export function emptyModel(): RunModel {
  return { version: 1, updatedAt: new Date().toISOString(), bucketSeconds: BUCKET_SECONDS, cells: {} };
}

export function loadModel(path: string): RunModel {
  if (!existsSync(path)) return emptyModel();
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as RunModel;
    if (m.version !== 1 || !m.cells) return emptyModel();
    return m;
  } catch {
    return emptyModel();
  }
}

export interface Observation { line: string; from: string; to: string; dep: string; sec: number; }

// Merge new observations into the cumulative model. Counts add — that's all a
// histogram merge is, which is why this works across jobs, days and machines
// with no coordination whatsoever.
export function mergeObservations(model: RunModel, obs: Observation[]): number {
  // Forget a little, before remembering more.
  if (obs.length) applyDecay(model, dateOf(obs[0].dep));
  let added = 0;
  for (const o of obs) {
    if (!Number.isFinite(o.sec) || o.sec <= 0) continue;
    const key = `${o.line}|${o.from}|${o.to}|${bandOf(o.dep)}`;
    const cell = model.cells[key] ?? { h: {}, n: 0 };
    const b = String(bucketOf(o.sec));
    cell.h[b] = (cell.h[b] ?? 0) + 1;
    cell.n++;
    cell.s = dateOf(o.dep);   // touched today → immune to the ghost sweep
    model.cells[key] = cell;
    added++;
  }
  model.updatedAt = new Date().toISOString();
  return added;
}

// Serialize a ROUNDED projection. Decay leaves weights as long floats
// (5.221609876…), and that full precision was half the file's bytes while adding
// nothing the product can use — a p50/p90 read off 15-second buckets is
// unaffected by the 3rd decimal of a weight. So round n and every bucket to 2dp
// and drop buckets whose weight has decayed below 0.05. Dropped mass is a
// fraction of a percent of a shipping cell (n≥20), so p50/p90 are untouched; n
// is left as-is to keep the n≥20 shipping gate stable. The in-memory model is not
// mutated — only what we write is compact.
function compact(model: RunModel): RunModel {
  const cells: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(model.cells)) {
    const h: Record<string, number> = {};
    for (const b of Object.keys(cell.h)) {
      const w = Math.round(cell.h[b] * 100) / 100;
      if (w >= 0.05) h[b] = w;
    }
    if (Object.keys(h).length === 0) continue;   // nothing left to say
    cells[key] = { h, n: Math.round(cell.n * 100) / 100, ...(cell.s ? { s: cell.s } : {}) };
  }
  return { ...model, cells };
}

export function saveModel(path: string, model: RunModel): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(compact(model)));
}

// Any percentile you like, from the histogram. This is what a mean cannot do.
export function percentile(cell: Cell, q: number): number | null {
  if (cell.n === 0) return null;
  const target = q * cell.n;
  let seen = 0;
  const keys = Object.keys(cell.h).map(Number).sort((a, b) => a - b);
  for (const b of keys) {
    seen += cell.h[String(b)];
    if (seen >= target) {
      // Mid-point of the bucket — we don't know where in it the value fell, and
      // pretending otherwise would be false precision.
      return Math.round((b + 0.5) * BUCKET_SECONDS);
    }
  }
  return null;
}

export interface CellStats {
  line: string; from: string; to: string; band: string;
  n: number; p50: number | null; p90: number | null;
}

export function statsFor(model: RunModel, minN = 5): CellStats[] {
  const out: CellStats[] = [];
  for (const [key, cell] of Object.entries(model.cells)) {
    if (cell.n < minN) continue;   // below this, a percentile is theatre
    const [line, from, to, band] = key.split('|');
    out.push({
      line, from, to, band,
      n: cell.n,
      p50: percentile(cell, 0.5),
      p90: percentile(cell, 0.9),
    });
  }
  return out;
}

// The artefact the APP ships: p50 and p90 per segment per band, no histograms.
// Small enough to bake into the bundle.
export function exportForApp(model: RunModel, minN = 20) {
  const cells = statsFor(model, minN);
  return {
    generatedAt: new Date().toISOString(),
    note: 'Observed run times. p50 = typical, p90 = what a bad day looks like.',
    minObservations: minN,
    segments: cells.map((c) => ({
      l: c.line, f: c.from, t: c.to, b: c.band, n: c.n, p50: c.p50, p90: c.p90,
    })),
  };
}
