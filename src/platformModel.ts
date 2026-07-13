import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dayType, dateOf } from './calendar';
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
  // platform → times seen (fractional, because of decay)
  p: Record<string, number>;
  n: number;
  // THE DRIFT GUARD — the most recent platforms actually used, newest last.
  //
  // Decay alone is too slow at the moment it matters most. In the first few days
  // after a timetable change, six months of "platform 12" still outvotes three
  // days of "platform 5" — so the model would confidently send someone to the
  // WRONG platform, which is the one failure that loses a user permanently.
  //
  // So we watch the recent past directly. If the last two observations both
  // disagree with the historical favourite, we stop predicting AT ONCE and wait
  // for the new pattern to establish itself. Two days of silence beats one day of
  // confidently sending someone to the wrong end of Waterloo.
  recent?: string[];
  // How early Darwin itself announced it, in minutes before departure. This is
  // the benchmark we're trying to beat.
  darwinLeadSum: number;
  darwinLeadN: number;
}

export interface PlatformModel {
  version: 1;
  updatedAt: string;
  decayedOn?: string;
  // key = `${crs}|${std}|${dest}|${wd|we|bh}`
  cells: Record<string, PlatformCell>;
}

// EXPONENTIAL FORGETTING — the fix for the timetable change.
//
// The national timetable changes every May and December. The 18:42 to Woking may
// become the 18:45; the platform policy may change entirely. Without forgetting,
// six months of old evidence outvotes three weeks of new — and the model tells
// someone platform 12 with 90% confidence while their train sits on platform 5.
// Confidently wrong is the one failure that loses a user permanently.
//
// Decay solves it WITHOUT having to detect the change. Old votes fade; new ones
// take over; and during the transition the votes SPLIT, so confidence collapses
// and the app SAYS NOTHING. Silence is the correct failure mode.
//
// Half-life is shorter here (21 days) than for run times, because a platform
// change is a step function — it's right until the day it's abruptly wrong —
// whereas run times drift gently.
const HALF_LIFE_DAYS = 21;
const DECAY_PER_DAY = Math.pow(0.5, 1 / HALF_LIFE_DAYS);
const PRUNE_BELOW_N = 0.5;

export function applyPlatformDecay(model: PlatformModel, today: string): number {
  if (model.decayedOn === today) return 0;
  const last = model.decayedOn ? Date.parse(model.decayedOn) : Date.parse(today);
  const days = Math.max(0, Math.round((Date.parse(today) - last) / 86400000));
  model.decayedOn = today;
  if (days === 0) return 0;

  const factor = Math.pow(DECAY_PER_DAY, days);
  let pruned = 0;
  for (const [key, cell] of Object.entries(model.cells)) {
    cell.n *= factor;
    cell.darwinLeadSum *= factor;
    cell.darwinLeadN *= factor;
    for (const pl of Object.keys(cell.p)) {
      cell.p[pl] *= factor;
      if (cell.p[pl] < 0.01) delete cell.p[pl];
    }
    if (cell.n < PRUNE_BELOW_N || Object.keys(cell.p).length === 0) {
      delete model.cells[key];
      pruned++;
    }
  }
  return pruned;
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

// Bank holidays get their OWN bucket — not folded into "weekend". Some operators
// run a Saturday service on a bank holiday, some a Sunday one. We don't guess.
// There are only ~8 a year, so the model will rarely be confident about them —
// which is exactly right. It stays quiet.
const keyFor = (c: { crs: string; std: string; destination?: string }, iso: string) =>
  `${c.crs}|${c.std}|${c.destination ?? '?'}|${dayType(iso)}`;

// Merge platform observations. Only the moment the platform is FIRST announced
// carries the lead-time information — after that it's just repetition.
export function mergePlatforms(model: PlatformModel, changes: RailChange[]): number {
  if (changes.length) applyPlatformDecay(model, dateOf(changes[0].t));
  let added = 0;
  for (const c of changes) {
    if (!c.platform || !c.std) continue;
    const key = keyFor(c, c.t);
    const cell = model.cells[key] ?? { p: {}, n: 0, darwinLeadSum: 0, darwinLeadN: 0 };

    cell.p[c.platform] = (cell.p[c.platform] ?? 0) + 1;
    cell.n++;

    // Only count ONE observation per service per day for the recency window —
    // otherwise a train we watch for 40 polls floods it with the same platform.
    const day = dateOf(c.t);
    const stamp = `${day}:${c.platform}`;
    cell.recent = cell.recent ?? [];
    if (cell.recent[cell.recent.length - 1] !== stamp) {
      cell.recent.push(stamp);
      if (cell.recent.length > 6) cell.recent.shift();
    }

    // CHANGE-POINT RESET.
    //
    // Decay alone recovers far too slowly: after a timetable change, six months
    // of old votes take MONTHS to fade, so the model would sit silent for weeks
    // when it could be useful within days. Silence is safe, but silence for a
    // month is a broken feature.
    //
    // So: if the last THREE days all agree with EACH OTHER and all disagree with
    // the historical favourite, this isn't noise — the pattern has genuinely
    // changed. Throw the old evidence away and start again from what's true now.
    //
    // Three, not two: a single diverted train is common, two in a row is
    // plausible bad luck, three consecutive days on a new platform is a decision
    // someone made.
    const last3 = cell.recent.slice(-3).map((r) => r.split(':')[1]);
    if (last3.length === 3 && new Set(last3).size === 1) {
      const nowPlat = last3[0];
      const favourite = Object.entries(cell.p).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (favourite && favourite !== nowPlat) {
        // Reset to the new reality. Keep the Darwin lead-time stats — those are
        // about the FEED, not the platform, and they don't go stale.
        cell.p = { [nowPlat]: 3 };
        cell.n = 3;
      }
    }

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

    // DRIFT GUARD. If the last two days both used a different platform from the
    // historical favourite, something has changed — a timetable, a closure, an
    // engineering possession. Say nothing until we know what.
    const recent = (cell.recent ?? []).map((r) => r.split(':')[1]);
    const last2 = recent.slice(-2);
    if (last2.length === 2 && last2.every((r) => r !== platform)) continue;
    out.push({
      key, crs, std, destination,
      platform,
      confidence: Number((count / cell.n).toFixed(2)),
      n: Number(cell.n.toFixed(1)),
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
