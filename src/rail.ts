// NATIONAL RAIL — Darwin, via the Rail Data Marketplace.
//
// WHY THIS HAS A CLOCK ON IT, when HSP doesn't:
//
// HSP (Historic Service Performance) gives you punctuality retrospectively — up
// to a year back — so the reliability data can wait. You can pull it any time.
//
// But HSP does NOT keep PLATFORM history. Darwin publishes the platform, the
// train departs, and that fact is gone forever. Nobody archives it publicly.
//
// So every day this doesn't run is a day of platform allocations that can never
// be recovered. And platform allocations are what build "the 18:42 to Woking
// goes from platform 12" — most of Realtime Trains' party trick, without the
// signalling feed, from data anyone could have collected and didn't.
//
// The second thing worth having, also ephemeral: the DELAY TRAJECTORY. HSP tells
// you a train WAS 20 minutes late. It doesn't tell you how the delay grew — 5,
// then 12, then 20 — which is exactly what makes the "wait or go" call
// evidence-based rather than optimistic.
//
// ENDPOINT (the RDM docs are, by community consensus, poor — so, precisely):
//   GET https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails/{CRS}
//   Header: x-apikey: <CONSUMER KEY>   ← the consumer KEY, not the secret.
//   The key lives on the product's "Specification" tab in the Marketplace.

import { londonMinutesOfDay } from './calendar';

export const RAIL_BASE =
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';

// London termini + the big commuter interchanges. These are where people get
// stranded, and where the platform question actually matters.
export const DEFAULT_CRS = [
  'WAT', 'VIC', 'LST', 'PAD', 'KGX', 'EUS', 'STP', 'CHX', 'CST', 'FST',
  'LBG', 'MYB', 'BFR', 'CLJ', 'ECR', 'SRA', 'WIM', 'SUR', 'RMD', 'VXH',
];

export interface Service {
  // Darwin's serviceID is a base64-ish opaque token, unique to this running of
  // this train. It's the only reliable way to follow one service over time.
  serviceId: string;
  crs: string;              // the station we're watching
  std: string;              // scheduled departure, "18:42"
  etd: string;              // "On time" | "18:55" | "Delayed" | "Cancelled"
  platform?: string;
  operator?: string;
  destination?: string;
  cancelled: boolean;
  delayReason?: string;
  cancelReason?: string;
}

const firstDest = (s: any): string | undefined =>
  s?.destination?.[0]?.locationName ?? s?.destination?.location?.[0]?.locationName;

export function toServices(board: any, crs: string): Service[] {
  const raw = board?.trainServices ?? board?.trainServices?.service ?? [];
  const list = Array.isArray(raw) ? raw : [raw].filter(Boolean);

  return list
    .filter((s: any) => s && (s.serviceID || s.serviceId))
    .map((s: any) => ({
      serviceId: String(s.serviceID ?? s.serviceId),
      crs,
      std: String(s.std ?? ''),
      etd: String(s.etd ?? ''),
      // Darwin omits the platform entirely until it's decided — which is the
      // whole point. An absent platform is DATA, not a gap: it tells us the
      // allocation hasn't been announced yet, and the moment it appears is the
      // thing we're measuring ourselves against.
      platform: s.platform ? String(s.platform) : undefined,
      operator: s.operator ? String(s.operator) : undefined,
      destination: firstDest(s),
      cancelled: Boolean(s.isCancelled),
      delayReason: s.delayReason ? String(s.delayReason) : undefined,
      cancelReason: s.cancelReason ? String(s.cancelReason) : undefined,
    }));
}

// Minutes late, from the etd/std pair. Darwin returns strings, not times, and
// they can be "On time", "Delayed" (meaning: late, amount unknown), "Cancelled"
// or "No report". Parsing them naively as times is the classic mistake.
export function minutesLate(std: string, etd: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(std)) return null;
  if (/on time/i.test(etd)) return 0;
  if (!/^\d{2}:\d{2}/.test(etd)) return null;   // "Delayed" / "Cancelled" — unknown
  const [sh, sm] = std.split(':').map(Number);
  const [eh, em] = etd.slice(0, 5).split(':').map(Number);
  let d = (eh * 60 + em) - (sh * 60 + sm);
  if (d < -720) d += 1440;    // over midnight
  if (d > 720) d -= 1440;
  return d;
}

// A fingerprint of everything we care about. We write ONLY when this changes —
// an event log, not a poll log. A service sits unchanged for most of its life,
// so this collapses storage while keeping full resolution on the moments that
// matter: the platform appearing, the delay growing, the cancellation landing.
export function fingerprint(s: Service): string {
  return [s.serviceId, s.etd, s.platform ?? '', s.cancelled ? 'C' : '',
    s.delayReason ?? '', s.cancelReason ?? ''].join('~');
}

export interface RailChange {
  t: string;                 // when we first saw this state
  serviceId: string;
  crs: string;
  std: string;
  etd: string;
  platform?: string;
  destination?: string;
  operator?: string;
  cancelled?: boolean;
  lateMin?: number | null;
  reason?: string;
  // Was this the moment the platform was FIRST announced? That's the number we
  // have to beat: Darwin typically only confirms it a few minutes out.
  platformFirstSeen?: boolean;
  minsBeforeDeparture?: number | null;
}

// How many minutes until this train departs.
//
// THE BUG THIS FIXES: setHours() uses the RUNNER's timezone, and GitHub Actions
// runs in UTC. But Darwin's `std` is LONDON local. In British Summer Time, 23:22
// London is 22:22 UTC — so building the departure with UTC hours put it an hour
// LATER than it really was, and inflated every measured Darwin lead time by
// exactly 60 minutes. It reported 73 minutes. The truth was 13.
export function minsUntil(std: string, now: Date): number | null {
  if (!/^\d{2}:\d{2}$/.test(std)) return null;
  const [h, m] = std.split(':').map(Number);
  const depMin = h * 60 + m;
  const nowMin = londonMinutesOfDay(now);
  let diff = depMin - nowMin;
  if (diff < -720) diff += 1440;   // over midnight
  if (diff > 720) diff -= 1440;
  return Math.round(diff);
}

export function diffServices(
  prev: Map<string, Service>,
  next: Service[],
  now: Date,
): RailChange[] {
  const out: RailChange[] = [];
  for (const s of next) {
    const old = prev.get(s.serviceId);
    if (old && fingerprint(old) === fingerprint(s)) continue;

    const platformFirstSeen = Boolean(s.platform) && !old?.platform;

    const rec: RailChange = {
      t: now.toISOString(),
      serviceId: s.serviceId,
      crs: s.crs,
      std: s.std,
      etd: s.etd,
      lateMin: minutesLate(s.std, s.etd),
    };
    if (s.platform) rec.platform = s.platform;
    if (s.destination) rec.destination = s.destination;
    if (s.operator) rec.operator = s.operator;
    if (s.cancelled) rec.cancelled = true;
    const reason = s.cancelReason ?? s.delayReason;
    if (reason) rec.reason = reason;
    if (platformFirstSeen) {
      rec.platformFirstSeen = true;
      rec.minsBeforeDeparture = minsUntil(s.std, now);
    }
    out.push(rec);
  }
  return out;
}
