// Crowding.
//
// WHAT THIS IS FOR — read this before using the numbers, because the scale is a
// trap.
//
// TfL's live crowding value is a fraction of THAT STATION'S OWN busiest moment
// since July 2019. It is NOT comparable across stations. 0.8 at Chesham and 0.8
// at Oxford Circus are wildly different numbers of humans. Any heatmap plotting
// raw values would tell people a sleepy suburban station is "as busy as" Oxford
// Circus — worse than no heatmap at all.
//
// To compare stations you must normalise by absolute footfall (TfL's annual
// station entry/exit counts). That conversion is APPROXIMATE — relative-to-own-
// max isn't linearly convertible to absolute throughput without knowing each
// station's absolute peak. Label any such figure an estimate.
//
// WHY WE ARCHIVE IT AT ALL, given TfL publishes historical crowding:
//
// Historical crowding is an AVERAGE. Averages smooth away incidents. What nobody
// has — including TfL, publicly — is how crowding behaves WHEN THINGS BREAK:
// when the Victoria line fails at 18:10, where does the crowd go, which stations
// become unbearable, and how long does the surge take to clear.
//
// That interaction is the whole point of the rescue screen. If we tell everyone
// to reroute via Clapham Junction, Clapham Junction becomes the new crush. This
// dataset is the only way to eventually know that — and it cannot be recovered
// retrospectively.

export interface CrowdSample {
  station: string;          // naptan
  // Fraction of this station's own historical maximum. NOT cross-comparable.
  pctOfMax: number;
  t: string;                // ISO
}

export interface CrowdRecord extends CrowdSample {
  // The reason this row exists: what was broken at the time. Empty on a normal
  // day (and on normal days we don't write at all — see shouldRecord).
  disruptedLines?: string[];
}

export function toCrowdSample(raw: any, station: string, now: Date): CrowdSample | null {
  // The live endpoint returns percentageOfBaseline (0..1-ish). Field naming has
  // varied, so accept the plausible spellings rather than silently returning 0.
  const v =
    raw?.percentageOfBaseline ??
    raw?.percentageOfBaseLine ??
    raw?.percentage ??
    null;
  if (v === null || !Number.isFinite(Number(v))) return null;
  return { station, pctOfMax: Number(v), t: now.toISOString() };
}

// Only write when it's worth writing.
//
// On a normal day, live crowding is just the historical pattern playing out —
// and TfL already publishes that, so archiving it is pure noise. We record when
// EITHER something is disrupted (the interaction nobody has) OR the station is
// unusually busy for the time of day (an anomaly worth keeping).
export function shouldRecord(
  sample: CrowdSample,
  disruptedLines: string[],
  anomalyThreshold = 0.75,
): boolean {
  if (disruptedLines.length > 0) return true;
  return sample.pctOfMax >= anomalyThreshold;
}

// The big interchanges — where a surge actually hurts. Polling all 428 stations
// every 5 minutes would be wasteful and add little: crowding at Chesham is not
// what strands anyone.
export const CROWD_STATIONS: string[] = (process.env.CROWD_STATIONS ??
  '940GZZLUOXC,940GZZLUVIC,940GZZLUKSX,940GZZLUWLO,940GZZLULVT,940GZZLUBNK,' +
  '940GZZLUEUS,940GZZLUCHX,940GZZLUPAD,940GZZLUSTR,940GZZLUCLJ,940GZZLUGPK,' +
  '940GZZLUTCR,940GZZLULSQ,940GZZLUBST,940GZZLUCYF,940GZZLUCAN,940GZZLUHYC'
).split(',').map((s) => s.trim()).filter(Boolean);
