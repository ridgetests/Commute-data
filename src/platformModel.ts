import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RailChange } from './rail';

// THE PLATFORM MODEL — most of Realtime Trains' party trick, without the
// signalling feed.
//
// The claim RTT makes is that it knows the platform before the boards do. It
// does that by ingesting Network Rail's raw signalling (TD) feed and modelling
// berth-to-platform allocation. That's a heavy piece of infrastructure.
//
// But there's a much cheaper route to most of the same value: the 18:42 to
// Woking has left from platform 12 on 43 of the last 47 weekdays. You don't need
// signalling data to know that. You need HISTORY — which nobody archives,
// because Darwin publishes the platform and then it's gone.
//
// So the model is a frequency table, and it earns its keep in two numbers:
//   • CONFIDENCE — how often this service uses this platform.
//   • LEAD — how many minutes EARLIER than Darwin we can say it.
//
// That second number is the whole product. If Darwin confirms the platform four
// minutes before departure, and we can say it with 90% confidence twenty minutes
// out, we've given the traveller sixteen minutes of standing in the right place.
// That is the entire feature, and it's measurable from the data itself.
//
// ASSUMPTIONS, STATED:
// • Keyed on (station, scheduled time, destination). Same train, same slot, most
//   days. Ignores the timetable changing — which it does, twice a year — so the
//   model needs an age-out. Not yet built; flagged.
// • Weekday/weekend split, because Sunday's 18:42 is a different train.
// • A platform seen once is not a pattern. `confidence` is meaningless below a
//   handful of observations, and the export suppresses it.

export interface PlatformCell {
  // platform → times seen
  p: Record<string, number>;
  n: number;
  // How early Darwin itself announced it, in minutes before departure. This is
  // the benchmark we're trying to beat.
  darwinLeadSum: number;
  darwinLeadN: number;
}

export interface PlatformModel {
  version: 1;
  updatedAt: string;
  // key = `${crs}|${std}|${dest}|${wd|we}`
  cells: Record<string, PlatformCell>;
}

export const emptyPlatformModel = (): PlatformModel =>
  ({ version: 1, updatedAt: new Date().toISOString(), cells: {} });

export function loadPlatformModel(path: string): PlatformModel {
  if (!existsSync(path)) return emptyPlatformModel();
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as PlatformModel;
    return m.version === 1 && m.cells ? m : emptyPlatformModel();
  } catch {
    return emptyPlatformModel();
  }
}

const keyFor = (c: { crs: string; std: string; destination?: string }, iso: string) => {
  const d = new Date(iso);
  const we = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 'we' : 'wd';
  return `${c.crs}|${c.std}|${c.destination ?? '?'}|${we}`;
};

// Merge platform observations. Only the moment the platform is FIRST announced
// carries the lead-time information — after that it's just repetition.
export function mergePlatforms(model: PlatformModel, changes: RailChange[]): number {
  let added = 0;
  for (const c of changes) {
    if (!c.platform || !c.std) continue;
    const key = keyFor(c, c.t);
    const cell = model.cells[key] ?? { p: {}, n: 0, darwinLeadSum: 0, darwinLeadN: 0 };

    cell.p[c.platform] = (cell.p[c.platform] ?? 0) + 1;
    cell.n++;

    if (c.platformFirstSeen && typeof c.minsBeforeDeparture === 'number'
        && c.minsBeforeDeparture >= 0 && c.minsBeforeDeparture < 240) {
      cell.darwinLeadSum += c.minsBeforeDeparture;
      cell.darwinLeadN++;
    }

    model.cells[key] = cell;
    added++;
  }
  model.updatedAt = new Date().toISOString();
  return added;
}

export const savePlatformModel = (path: string, m: PlatformModel): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(m));
};

export interface Prediction {
  key: string;
  crs: string; std: string; destination: string;
  platform: string;
  confidence: number;     // 0..1
  n: number;
  darwinLeadMin: number | null;   // how early DARWIN says it — the benchmark
}

// The artefact the app ships: the most likely platform, with honest confidence.
// Below minN we say nothing at all rather than guess — a wrong platform, stated
// confidently, is the single worst thing this app could do.
export function predictions(model: PlatformModel, minN = 5): Prediction[] {
  const out: Prediction[] = [];
  for (const [key, cell] of Object.entries(model.cells)) {
    if (cell.n < minN) continue;
    const [crs, std, destination] = key.split('|');
    const [platform, count] = Object.entries(cell.p)
      .sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!platform) continue;
    out.push({
      key, crs, std, destination,
      platform,
      confidence: Number((count / cell.n).toFixed(2)),
      n: cell.n,
      darwinLeadMin: cell.darwinLeadN
        ? Number((cell.darwinLeadSum / cell.darwinLeadN).toFixed(1))
        : null,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

// THE HEADLINE METRIC. How much earlier can we say it than Darwin can?
export function benchmark(model: PlatformModel, minN = 5) {
  const preds = predictions(model, minN);
  const usable = preds.filter((p) => p.confidence >= 0.8);
  const leads = preds.map((p) => p.darwinLeadMin).filter((x): x is number => x !== null);
  return {
    servicesModelled: preds.length,
    confident: usable.length,          // ≥80% — the ones we'd actually show
    darwinMedianLeadMin: leads.length
      ? leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)]
      : null,
    note: 'darwinMedianLeadMin is how many minutes before departure Darwin itself '
      + 'announces the platform. Anything we can say earlier than that, with '
      + 'confidence, is the feature.',
  };
}
