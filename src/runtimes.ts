// Observed run times — the fix for the biggest accuracy hole.
//
// Right now every journey time in the app is a GEOMETRIC ESTIMATE: straight-line
// distance ÷ assumed speed. Every "12 min faster" claim inherits that error.
// TfL does not publish historical arrival times, so observed run times cannot be
// recovered retrospectively. Collect now or never.
//
// Method: poll /Line/{id}/Arrivals every 60s. Each prediction carries a vehicleId,
// a station, and an expectedArrival. When a vehicle's prediction for a station
// DISAPPEARS, the last expectedArrival we saw is our best estimate of when it
// actually arrived. Consecutive arrivals by the same vehicle = one observed
// segment traversal.
//
// Bonus, and it matters: the same feed carries platformName and `towards`. That
// gives us (a) DIRECTION — "Bakerloo northbound towards Harrow & Wealdstone",
// the thing every tube app fails to tell you while you stand between two tunnels
// — and (b) platform history, the seed of platform prediction.

export interface Prediction {
  vehicleId: string;
  naptanId: string;
  lineId: string;
  expectedArrival: string;   // ISO
  platformName?: string;
  towards?: string;
  direction?: string;        // inbound / outbound
  destinationName?: string;
}

export interface RunObservation {
  t: string;                 // when the second station was reached
  line: string;
  from: string;              // naptan id
  to: string;                // naptan id
  seconds: number;           // observed run time
  towards?: string;
  direction?: string;
}

export interface PlatformObservation {
  t: string;
  line: string;
  station: string;
  platform: string;
  towards?: string;
  direction?: string;
}

interface Tracked {
  expectedArrival: number;   // epoch ms
  seenAt: number;
  platform?: string;
  towards?: string;
  direction?: string;
  line: string;
}

// Ignore absurd gaps — vehicles that vanish and reappear, terminus turnarounds,
// or predictions that jumped. A tube hop is roughly 60s–6min.
const MIN_RUN = 40;
const MAX_RUN = 600;

export class RunTracker {
  // vehicleId → naptanId → tracked prediction
  private live = new Map<string, Map<string, Tracked>>();
  // vehicleId → ordered list of confirmed arrivals
  private arrived = new Map<string, { station: string; at: number; line: string;
    towards?: string; direction?: string }[]>();
  private seenPlatforms = new Set<string>();

  // Feed one poll's worth of predictions. Returns anything newly observed.
  ingest(preds: Prediction[], now = Date.now()): {
    runs: RunObservation[];
    platforms: PlatformObservation[];
  } {
    const runs: RunObservation[] = [];
    const platforms: PlatformObservation[] = [];

    // Index this poll by vehicle.
    const poll = new Map<string, Map<string, Tracked>>();
    for (const p of preds) {
      if (!p.vehicleId || !p.naptanId || !p.expectedArrival) continue;
      const m = poll.get(p.vehicleId) ?? new Map<string, Tracked>();
      m.set(p.naptanId, {
        expectedArrival: Date.parse(p.expectedArrival),
        seenAt: now,
        platform: p.platformName,
        towards: p.towards ?? p.destinationName,
        direction: p.direction,
        line: p.lineId,
      });
      poll.set(p.vehicleId, m);

      // Platform + direction observation — dedupe so we only log new combinations.
      if (p.platformName) {
        const key = `${p.lineId}|${p.naptanId}|${p.platformName}|${p.towards ?? ''}`;
        if (!this.seenPlatforms.has(key)) {
          this.seenPlatforms.add(key);
          platforms.push({
            t: new Date(now).toISOString(),
            line: p.lineId,
            station: p.naptanId,
            platform: p.platformName,
            towards: p.towards ?? p.destinationName,
            direction: p.direction,
          });
        }
      }
    }

    // Any station prediction that was live last poll but is gone now → arrived.
    for (const [vehicleId, prevStations] of this.live) {
      const nowStations = poll.get(vehicleId);
      for (const [naptanId, t] of prevStations) {
        if (nowStations?.has(naptanId)) continue; // still pending
        // Disappeared → treat last expectedArrival as the actual arrival.
        const list = this.arrived.get(vehicleId) ?? [];
        if (!list.some((a) => a.station === naptanId)) {
          list.push({ station: naptanId, at: t.expectedArrival, line: t.line,
            towards: t.towards, direction: t.direction });
          list.sort((a, b) => a.at - b.at);
          this.arrived.set(vehicleId, list);

          // New consecutive pair → one observed run time.
          const i = list.findIndex((a) => a.station === naptanId);
          if (i > 0) {
            const a = list[i - 1];
            const b = list[i];
            const secs = Math.round((b.at - a.at) / 1000);
            if (secs >= MIN_RUN && secs <= MAX_RUN && a.station !== b.station) {
              runs.push({
                t: new Date(b.at).toISOString(),
                dep: new Date(a.at).toISOString(),
                sec: secs,
                line: b.line,
                from: a.station,
                to: b.station,
                seconds: secs,
                towards: b.towards,
                direction: b.direction,
              });
            }
          }
        }
      }
    }

    this.live = poll;
    this.prune(now);
    return { runs, platforms };
  }

  // Don't grow forever inside a 6-hour job.
  private prune(now: number) {
    for (const [v, list] of this.arrived) {
      const recent = list.filter((a) => now - a.at < 45 * 60 * 1000);
      if (recent.length === 0) this.arrived.delete(v);
      else this.arrived.set(v, recent.slice(-6));
    }
  }
}

// Map TfL's raw arrivals response to our shape.
export function toPredictions(raw: any[]): Prediction[] {
  return raw.map((a) => ({
    vehicleId: a.vehicleId,
    naptanId: a.naptanId,
    lineId: a.lineId,
    expectedArrival: a.expectedArrival,
    platformName: a.platformName,
    towards: a.towards,
    direction: a.direction,
    destinationName: a.destinationName,
  }));
}
