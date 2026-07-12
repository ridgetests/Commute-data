import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Turn the raw event log into something a human can look at.
//
// The event log is a stream of state CHANGES. An incident is not a row in it —
// an incident is the story between a line going bad and coming good again. This
// reconstructs those stories, which is what makes the data legible: how often,
// how long, caused by what, and — the number the app actually needs — HOW LONG
// DELAYS OF EACH CAUSE TAKE TO CLEAR.
//
// Output is a single small summary.json so the dashboard loads instantly and the
// repo doesn't have to serve megabytes of JSONL to a browser.
//
// ASSUMPTIONS, STATED:
// • An incident "ends" when the line returns to sev 10 (Good Service). If a line
//   degrades, improves partially, then degrades again, we treat that as ONE
//   incident with a severity trajectory — not two. That's a judgement call; the
//   alternative (splitting on any improvement) would inflate incident counts.
// • Incidents still open when the log ends are excluded from duration stats,
//   otherwise we'd systematically under-report long ones (survivorship bias).
// • Cause is classified from TfL's prose by regex. It will be wrong sometimes.
//   'other' is the honest bucket, not a failure.

const DATA = join(process.cwd(), 'data');
const GOOD = 10;

interface Event {
  t: string; line: string; sev: number; desc: string;
  reason?: string; cause?: string; prevSev?: number;
  routes?: string[]; stops?: string[];
  from?: number; to?: number; segments?: string[];
}

interface Incident {
  line: string;
  cause: string;
  start: string;
  end?: string;
  minutes?: number;
  worstSev: number;
  peakAfterMin?: number;   // how long until it was at its worst
  segments: string[];
  reason?: string;
}

function loadEvents(): Event[] {
  const dir = join(DATA, 'events');
  if (!existsSync(dir)) return [];
  const out: Event[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

function sevOf(e: Event): number {
  return e.sev ?? e.to ?? GOOD;
}

function buildIncidents(events: Event[]): Incident[] {
  const open = new Map<string, Incident & { worstAt: string }>();
  const done: Incident[] = [];

  for (const e of events) {
    const sev = sevOf(e);
    const cur = open.get(e.line);

    if (sev < GOOD) {
      const segs = e.segments ?? e.routes ?? [];
      if (!cur) {
        open.set(e.line, {
          line: e.line,
          cause: e.cause ?? 'other',
          start: e.t,
          worstSev: sev,
          worstAt: e.t,
          segments: [...segs],
          reason: e.reason,
        });
      } else {
        if (sev < cur.worstSev) { cur.worstSev = sev; cur.worstAt = e.t; }
        for (const s of segs) if (!cur.segments.includes(s)) cur.segments.push(s);
        // A cause that becomes known later is better than 'other'.
        if (cur.cause === 'other' && e.cause && e.cause !== 'other') cur.cause = e.cause;
        if (!cur.reason && e.reason) cur.reason = e.reason;
      }
    } else if (cur) {
      const startMs = Date.parse(cur.start);
      const endMs = Date.parse(e.t);
      done.push({
        line: cur.line,
        cause: cur.cause,
        start: cur.start,
        end: e.t,
        minutes: Math.round((endMs - startMs) / 60000),
        worstSev: cur.worstSev,
        peakAfterMin: Math.round((Date.parse(cur.worstAt) - startMs) / 60000),
        segments: cur.segments,
        reason: cur.reason,
      });
      open.delete(e.line);
    }
  }
  // Still-open incidents are excluded from duration stats — including them would
  // systematically under-report the long ones.
  return done;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function main() {
  const events = loadEvents();
  const incidents = buildIncidents(events);

  const byCause = new Map<string, number[]>();
  const peakByCause = new Map<string, number[]>();
  const byLine = new Map<string, { n: number; mins: number[] }>();

  for (const i of incidents) {
    if (i.minutes === undefined) continue;
    (byCause.get(i.cause) ?? byCause.set(i.cause, []).get(i.cause)!).push(i.minutes);
    if (i.peakAfterMin !== undefined) {
      (peakByCause.get(i.cause) ?? peakByCause.set(i.cause, []).get(i.cause)!)
        .push(i.peakAfterMin);
    }
    const l = byLine.get(i.line) ?? { n: 0, mins: [] };
    l.n++; l.mins.push(i.minutes);
    byLine.set(i.line, l);
  }

  const days = new Set(events.map((e) => e.t.slice(0, 10)));

  const summary = {
    generatedAt: new Date().toISOString(),
    coverage: {
      days: days.size,
      firstEvent: events[0]?.t ?? null,
      lastEvent: events[events.length - 1]?.t ?? null,
      events: events.length,
      incidents: incidents.length,
    },
    // THE NUMBER THE APP NEEDS: how long does a delay of this cause take to clear,
    // and how long until it's at its worst. This is what turns "wait it out" from
    // a guess into evidence.
    recoveryByCause: [...byCause.entries()]
      .map(([cause, mins]) => ({
        cause,
        n: mins.length,
        medianMinutes: median(mins),
        p90Minutes: median(mins.length > 4 ? mins.sort((a, b) => a - b).slice(-Math.ceil(mins.length / 10)) : mins),
        medianPeakAfterMinutes: median(peakByCause.get(cause) ?? []),
      }))
      .sort((a, b) => b.n - a.n),
    worstLines: [...byLine.entries()]
      .map(([line, v]) => ({
        line,
        incidents: v.n,
        medianMinutes: median(v.mins),
        totalMinutes: v.mins.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes),
    recent: incidents.slice(-40).reverse(),
  };

  mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
  writeFileSync(join(process.cwd(), 'docs', 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(
    `Digest: ${events.length} events → ${incidents.length} incidents over ` +
    `${days.size} day(s). Wrote docs/summary.json`,
  );
  for (const r of summary.recoveryByCause.slice(0, 6)) {
    console.log(`  ${r.cause.padEnd(18)} n=${String(r.n).padStart(3)}  ` +
      `median ${r.medianMinutes} min  (worst after ~${r.medianPeakAfterMinutes} min)`);
  }
}

main();
