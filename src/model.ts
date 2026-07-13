import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
}

export interface RunModel {
  version: 1;
  updatedAt: string;
  bucketSeconds: number;
  // key = `${line}|${from}|${to}|${band}`
  cells: Record<string, Cell>;
}

export const bandOf = (iso: string): string => {
  const d = new Date(iso);
  const we = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  return `${we ? 'we' : 'wd'}-${String(d.getUTCHours()).padStart(2, '0')}`;
};

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
  let added = 0;
  for (const o of obs) {
    if (!Number.isFinite(o.sec) || o.sec <= 0) continue;
    const key = `${o.line}|${o.from}|${o.to}|${bandOf(o.dep)}`;
    const cell = model.cells[key] ?? { h: {}, n: 0 };
    const b = String(bucketOf(o.sec));
    cell.h[b] = (cell.h[b] ?? 0) + 1;
    cell.n++;
    model.cells[key] = cell;
    added++;
  }
  model.updatedAt = new Date().toISOString();
  return added;
}

export function saveModel(path: string, model: RunModel): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(model));
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
