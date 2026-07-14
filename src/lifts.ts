// LIFTS.
//
// A step-free route is not "slightly worse" when the lift is broken. It is a
// person stranded at the bottom of a staircase. Right now the app would route
// them confidently into exactly that.
//
// TfL publishes live lift disruptions. Nobody archives them. So:
//   • LIVE  → the app must refuse step-free routes through a station whose lift
//             is out, and say why.
//   • HISTORY → lift outage history is EPHEMERAL and unpublished. Which lifts
//             break, how often, and for how long, is a dataset that does not
//             exist anywhere. Same clock as platforms: not collected today means
//             gone forever.
//
// THE ENDPOINT IS FLAKY, AND THIS MATTERS.
//
// TfL took /Disruptions/Lifts/v2 offline in May 2025 over database problems, and
// developers report roughly 8% of calls failing. So:
//
//   FAILING TO REACH THE API IS NOT THE SAME AS "ALL LIFTS WORKING".
//
// That distinction is the whole safety story. If we can't reach the feed, we say
// "lift status unknown — check before you travel", NOT silence. Silently assuming
// lifts are fine is how you strand a wheelchair user, and it would be entirely
// our fault.

export const LIFTS_V2 = 'https://api.tfl.gov.uk/Disruptions/Lifts/v2';
export const LIFTS_V1 = 'https://api.tfl.gov.uk/Disruptions/Lifts';

export interface LiftOutage {
  naptan: string;            // station id
  station: string;           // display name
  lift: string;              // which lift ("Lift to Piccadilly line platforms")
  message?: string;
  since?: string;            // ISO, when TfL says it started
}

export type LiftFeed =
  | { ok: true; outages: LiftOutage[]; fetchedAt: number }
  // The endpoint failed. We do NOT return an empty outage list — an empty list
  // means "all lifts working", and that is a claim we cannot make.
  | { ok: false; reason: string; fetchedAt: number };

export function parseLifts(raw: any): LiftOutage[] {
  const list = Array.isArray(raw) ? raw : (raw?.disruptions ?? []);
  return list
    .map((d: any) => {
      const naptan = String(d.icsCode ?? d.naptanCode ?? d.stopPointId ?? d.id ?? '');
      const station = String(d.stationName ?? d.commonName ?? d.name ?? '');
      const lift = String(d.liftName ?? d.description ?? d.title ?? 'Lift');
      if (!naptan && !station) return null;
      return {
        naptan,
        station,
        lift,
        message: d.message ? String(d.message) : undefined,
        since: d.outageStartArea ?? d.startDate ?? undefined,
      } as LiftOutage;
    })
    .filter((x: LiftOutage | null): x is LiftOutage => Boolean(x));
}

// Fingerprint for the event log: write only when the set of broken lifts changes.
export const liftKey = (o: LiftOutage) => `${o.naptan || o.station}~${o.lift}`;

export interface LiftEvent {
  t: string;
  station: string;
  naptan: string;
  lift: string;
  state: 'out' | 'restored';
  message?: string;
}

export function diffLifts(
  prev: Map<string, LiftOutage>,
  next: LiftOutage[],
  now: Date,
): LiftEvent[] {
  const out: LiftEvent[] = [];
  const seen = new Set<string>();

  for (const o of next) {
    const k = liftKey(o);
    seen.add(k);
    if (!prev.has(k)) {
      out.push({
        t: now.toISOString(), station: o.station, naptan: o.naptan,
        lift: o.lift, state: 'out', message: o.message,
      });
    }
  }
  for (const [k, o] of prev) {
    if (seen.has(k)) continue;
    out.push({
      t: now.toISOString(), station: o.station, naptan: o.naptan,
      lift: o.lift, state: 'restored',
    });
  }
  return out;
}
