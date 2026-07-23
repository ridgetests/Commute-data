// PUNCTUALITY — the model the harvest was always feeding, finally built.
//
// The collector has been banking rich per-service events all along: etd,
// lateMin, cancellations, reasons — written on every CHANGE into
// data/rail/*.jsonl (in git, daily). Only platforms ever got a model; the
// punctuality story sat unmodelled in the log. This closes that gap.
//
// ARCHITECTURE: rebuild-from-log, not incremental. The full event log lives
// in git, so the model is a PURE FUNCTION of it — rerun any time, idempotent,
// no merge state to corrupt (this week taught us what incremental state costs
// when workflows fight). Services are grouped across the WHOLE log by
// serviceId, so run boundaries can't double-count.
//
// OUTCOME per service = the PEAK numeric lateness we observed (delays rarely
// recover; the worst state seen is the honest summary of the pain), or
// cancellation. "Delayed" with no number is counted as UNKNOWN — reported,
// never guessed into the percentiles. Old days decay: half-life ~21 days,
// same philosophy as the platform model, so a timetable change washes out.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dayType } from './calendar';

const HALF_LIFE_DAYS = 21;
const MIN_WEIGHT = 3;          // a service needs ~3 recent sightings to speak
const LATE_CLAMP = 90;         // minutes; beyond this it's "a very bad day"

interface Outcome {
  crs: string; std: string; dest: string;
  day: string; dt: string;
  peakLate: number | null;     // max numeric lateMin seen, if any
  cancelled: boolean;
  delayedUnknown: boolean;     // saw "Delayed" but never a number
}

const railDir = join(process.cwd(), 'data', 'rail');
const files = readdirSync(railDir).filter((f) => f.endsWith('.jsonl')).sort();
if (files.length === 0) {
  console.error('No data/rail/*.jsonl found — nothing to model.');
  process.exit(1);
}

// ---- group the whole log by serviceId ----
const byService = new Map<string, Outcome>();
let records = 0;
for (const f of files) {
  const day = f.slice(0, 10);
  for (const line of readFileSync(join(railDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r?.serviceId || !r?.crs || !r?.std) continue;
    records++;
    const o = byService.get(r.serviceId) ?? {
      crs: r.crs, std: r.std, dest: r.destination ?? '?',
      day, dt: dayType(r.t ?? `${day}T12:00:00Z`),
      peakLate: null, cancelled: false, delayedUnknown: false,
    };
    if (r.destination) o.dest = r.destination;
    if (Number.isFinite(r.lateMin)) {
      o.peakLate = Math.max(o.peakLate ?? -999, r.lateMin);
    } else if (typeof r.etd === 'string' && /delayed/i.test(r.etd)) {
      o.delayedUnknown = true;
    }
    if (r.cancelled) o.cancelled = true;
    byService.set(r.serviceId, o);
  }
}

// ---- aggregate into cells, decayed by age ----
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d: string) =>
  Math.max(0, (Date.parse(today) - Date.parse(d)) / 86_400_000);
const weightOf = (d: string) => Math.pow(0.5, daysAgo(d) / HALF_LIFE_DAYS);

interface Cell {
  crs: string; std: string; dest: string; dt: string;
  hist: { late: number; w: number }[];
  n: number; canc: number; unk: number;
}
const cells = new Map<string, Cell>();
for (const o of byService.values()) {
  const key = `${o.crs}|${o.std}|${o.dest}|${o.dt}`;
  const c = cells.get(key) ?? {
    crs: o.crs, std: o.std, dest: o.dest, dt: o.dt,
    hist: [], n: 0, canc: 0, unk: 0,
  };
  const w = weightOf(o.day);
  c.n += w;
  if (o.cancelled) c.canc += w;
  else if (o.peakLate !== null && o.peakLate > -999) {
    c.hist.push({ late: Math.min(LATE_CLAMP, Math.max(-5, o.peakLate)), w });
  } else if (o.delayedUnknown) c.unk += w;
  cells.set(key, c);
}

// ---- weighted percentiles: the p90 IS the product ----
const pct = (hist: { late: number; w: number }[], p: number): number | null => {
  if (hist.length === 0) return null;
  const sorted = [...hist].sort((a, b) => a.late - b.late);
  const total = sorted.reduce((s, h) => s + h.w, 0);
  let cum = 0;
  for (const h of sorted) {
    cum += h.w;
    if (cum >= total * p) return h.late;
  }
  return sorted[sorted.length - 1].late;
};

const services = [...cells.values()]
  .filter((c) => c.n >= MIN_WEIGHT)
  .map((c) => ({
    crs: c.crs, std: c.std, destination: c.dest, dayType: c.dt,
    n: Number(c.n.toFixed(1)),
    p50Late: pct(c.hist, 0.5),
    p90Late: pct(c.hist, 0.9),
    cancelPct: Math.round((c.canc / c.n) * 100),
    unknownPct: Math.round((c.unk / c.n) * 100),
  }))
  .sort((a, b) => (b.p90Late ?? -1) - (a.p90Late ?? -1));

const out = {
  generatedAt: new Date().toISOString(),
  note: 'Peak observed lateness per service. p50 = typical, p90 = a bad day. '
    + 'Cancellations and unknown-length delays counted, never guessed.',
  days: files.length,
  servicesSeen: byService.size,
  cellsReady: services.length,
  services,
};
mkdirSync(join(process.cwd(), 'data', 'model'), { recursive: true });
writeFileSync(
  join(process.cwd(), 'data', 'model', 'rail-reliability.json'),
  JSON.stringify(out),
);

const worst = services.filter((s) => s.p90Late !== null).slice(0, 5);
console.log(`Punctuality model rebuilt from ${files.length} day(s) · `
  + `${records} events · ${byService.size} distinct services`);
console.log(`${services.length} service cells ready (weighted n ≥ ${MIN_WEIGHT})`);
for (const s of worst) {
  console.log(`  worst p90: ${s.crs} ${s.std} → ${s.destination} · `
    + `typically ${s.p50Late}m late, ${s.p90Late}m on a bad day · `
    + `${s.cancelPct}% cancelled`);
}
if (services.length === 0) {
  console.log('No cells ready yet — the log needs a few more days. Correct, not broken.');
}
