import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, statsFor, percentile, bandOf, type RunModel } from './model';

// THE PIT WALL.
//
// The dashboard's job is not to look impressive. It answers two questions:
//   1. What should I build next?
//   2. Is my data any good?
//
// So the hero is MODEL READINESS: which features are unblocked, which are still
// starved, and WHEN each will have enough data to be honest. A pit wall that only
// reports good news is decoration.
//
// ASSUMPTIONS, STATED (all surfaced in the UI too):
// • MIN_INCIDENTS = 20 per cause before a median means anything. Below ~20, one
//   freak 3-hour incident drags the median anywhere. Rule of thumb, not a law.
// • Forecasts assume incidents arrive at a roughly constant rate (Poisson). Real
//   life is bursty — strikes, heatwaves, leaf-fall — so the range is indicative.
// • "Trains lost" compares observed movements during the incident against the
//   same line, same weekday-type, same hour, on OTHER days. With only a few days
//   of history that baseline is thin, so the figure is suppressed until there are
//   at least MIN_BASELINE comparable days.

const DATA = join(process.cwd(), 'data');
const GOOD = 10;
const MIN_INCIDENTS = 20;
const MIN_BASELINE = 3;
const MIN_RUNS_READY = 2000;

interface Event {
  t: string; line: string; sev: number; desc?: string;
  reason?: string; cause?: string; prevSev?: number;
  routes?: string[]; stops?: string[]; segments?: string[];
}
interface Run { line: string; from: string; to: string; dep: string; sec: number; }

const readJsonl = <T,>(dir: string): T[] => {
  const p = join(DATA, dir);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const f of readdirSync(p).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(p, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
    }
  }
  return out;
};

const dirBytes = (dir: string): number => {
  const p = join(DATA, dir);
  if (!existsSync(p)) return 0;
  return readdirSync(p).reduce((n, f) => n + statSync(join(p, f)).size, 0);
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---------- incidents ----------

interface Incident {
  line: string; cause: string; start: string; end: string; minutes: number;
  // SEVERITY-SPLIT. "80 minutes disrupted" is a bad metric — it treats a slightly
  // late Circle line the same as a suspended Northern line. These say what
  // actually happened.
  minorMin: number; severeMin: number; suspendedMin: number;
  worstSev: number; peakAfterMin: number;
  segments: string[]; reason?: string;
  // The REAL severity trace — timestamped steps. The old dashboard DREW a curve
  // from start/peak/end and presented it as evidence. It wasn't.
  trace: { t: string; sev: number }[];
}

const bandOf = (sev: number) =>
  sev <= 4 ? 'suspended' : sev <= 6 ? 'severe' : sev < GOOD ? 'minor' : 'good';

function buildIncidents(events: Event[]): Incident[] {
  const open = new Map<string, {
    line: string; cause: string; start: string; worstSev: number; worstAt: string;
    segments: string[]; reason?: string; trace: { t: string; sev: number }[];
  }>();
  const done: Incident[] = [];

  for (const e of events) {
    const sev = e.sev ?? GOOD;
    const cur = open.get(e.line);

    if (sev < GOOD) {
      const segs = e.segments ?? e.routes ?? [];
      if (!cur) {
        open.set(e.line, {
          line: e.line, cause: e.cause ?? 'other', start: e.t,
          worstSev: sev, worstAt: e.t, segments: [...segs], reason: e.reason,
          trace: [{ t: e.t, sev }],
        });
      } else {
        cur.trace.push({ t: e.t, sev });
        if (sev < cur.worstSev) { cur.worstSev = sev; cur.worstAt = e.t; }
        for (const s of segs) if (!cur.segments.includes(s)) cur.segments.push(s);
        if (cur.cause === 'other' && e.cause && e.cause !== 'other') cur.cause = e.cause;
        if (!cur.reason && e.reason) cur.reason = e.reason;
      }
    } else if (cur) {
      cur.trace.push({ t: e.t, sev: GOOD });
      const startMs = Date.parse(cur.start);

      let minorMin = 0, severeMin = 0, suspendedMin = 0;
      for (let i = 0; i < cur.trace.length - 1; i++) {
        const dur = (Date.parse(cur.trace[i + 1].t) - Date.parse(cur.trace[i].t)) / 60000;
        const b = bandOf(cur.trace[i].sev);
        if (b === 'minor') minorMin += dur;
        else if (b === 'severe') severeMin += dur;
        else if (b === 'suspended') suspendedMin += dur;
      }

      done.push({
        line: cur.line, cause: cur.cause, start: cur.start, end: e.t,
        minutes: Math.round((Date.parse(e.t) - startMs) / 60000),
        minorMin: Math.round(minorMin),
        severeMin: Math.round(severeMin),
        suspendedMin: Math.round(suspendedMin),
        worstSev: cur.worstSev,
        peakAfterMin: Math.round((Date.parse(cur.worstAt) - startMs) / 60000),
        segments: cur.segments, reason: cur.reason, trace: cur.trace,
      });
      open.delete(e.line);
    }
  }
  return done;   // still-open incidents excluded: they'd bias durations downward
}

// ---------- trains lost ----------

// "14 trains lost" means nothing without a denominator. "70% fewer trains than
// normal for this line at this hour" is the number.
function trainsLost(runs: Run[], inc: Incident) {
  const startMs = Date.parse(inc.start);
  const endMs = Date.parse(inc.end);
  const hours = (endMs - startMs) / 3600000;
  if (hours <= 0) return null;

  const d0 = new Date(startMs);
  const weekend = d0.getUTCDay() === 0 || d0.getUTCDay() === 6;
  const hour = d0.getUTCHours();
  const dayKey = inc.start.slice(0, 10);
  const onLine = runs.filter((r) => r.line === inc.line);

  const during = onLine.filter((r) => {
    const t = Date.parse(r.dep);
    return t >= startMs && t <= endMs;
  }).length;

  const perDay = new Map<string, number>();
  for (const r of onLine) {
    const day = r.dep.slice(0, 10);
    if (day === dayKey) continue;
    const d = new Date(r.dep);
    const isWe = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (isWe !== weekend || d.getUTCHours() !== hour) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  if (perDay.size < MIN_BASELINE) {
    return { during, expected: null, pctLost: null, baselineDays: perDay.size };
  }
  const meanPerHour = [...perDay.values()].reduce((a, b) => a + b, 0) / perDay.size;
  const expected = Math.round(meanPerHour * hours);
  const pctLost = expected > 0
    ? Math.max(0, Math.round((1 - during / expected) * 100)) : null;
  return { during, expected, pctLost, baselineDays: perDay.size };
}

// ---------- readiness forecast ----------

// k more events at rate λ/day. The range widens as k shrinks — which is right:
// one incident tells you almost nothing about when the twentieth arrives.
function forecastDays(need: number, perDay: number): [number, number] | null {
  if (need <= 0) return [0, 0];
  if (perDay <= 0) return null;
  const mean = need / perDay;
  const sd = Math.sqrt(need) / perDay;
  return [Math.max(1, Math.round(mean - 1.64 * sd)), Math.round(mean + 1.64 * sd)];
}

const FEATURE: Record<string, string> = {
  signal: 'Signal failure — “how long will this last?”',
  fleet: 'Broken-down train — “how long will this last?”',
  'person-on-track': 'Someone on the track — “is it worth waiting?”',
  trespass: 'Trespass — “is it worth waiting?”',
  fatality: 'Emergency services — “is it worth waiting?”',
  weather: 'Weather — “how long will this last?”',
  staff: 'Staff shortage — “how long will this last?”',
  power: 'Power failure — “how long will this last?”',
  fire: 'Fire alert — “how long will this last?”',
  security: 'Security alert — “how long will this last?”',
  engineering: 'Engineering work',
  congestion: 'Knock-on delays',
  other: 'Unclassified disruption',
};

const cleanSegment = (s: string): string =>
  s.replace(/\s+Underground Station/gi, '')
    .replace(/\s+Rail Station/gi, '')
    .replace(/\s+-\s+/g, ' → ')
    .trim();

// ---------- main ----------

function main() {
  const events = readJsonl<Event>('events');
  // Raw movements now live in object storage, not git — so the dashboard reads the
  // MODEL. This loses per-incident train counting (which needed the raw), and the
  // page says so rather than quietly showing a worse number.
  const model = loadModel(join(DATA, 'model', 'runtimes.json'));
  const runs: Run[] = [];   // kept for shape; raw no longer in-repo
  const incidents = buildIncidents(events);

  const days = new Set([
    ...events.map((e) => e.t.slice(0, 10)),
    ...runs.map((r) => r.dep.slice(0, 10)),
  ]);
  const nDays = Math.max(1, days.size);

  // --- READINESS: the hero ---
  const byCause = new Map<string, Incident[]>();
  for (const i of incidents) {
    const l = byCause.get(i.cause) ?? [];
    l.push(i);
    byCause.set(i.cause, l);
  }

  const readiness = [...byCause.entries()].map(([cause, list]) => {
    const n = list.length;
    const perDay = n / nDays;
    const eta = forecastDays(Math.max(0, MIN_INCIDENTS - n), perDay);
    const mins = list.map((i) => i.minutes);
    return {
      cause,
      feature: FEATURE[cause] ?? cause,
      have: n,
      need: MIN_INCIDENTS,
      perDay: Number(perDay.toFixed(2)),
      ready: n >= MIN_INCIDENTS,
      etaDays: eta,
      medianMin: n ? median(mins) : null,
      p90Min: n ? quantile(mins, 0.9) : null,
    };
  }).sort((a, b) => (a.ready === b.ready ? b.have - a.have : a.ready ? -1 : 1));

  const runsByLine = new Map<string, number>();
  for (const r of runs) runsByLine.set(r.line, (runsByLine.get(r.line) ?? 0) + 1);
  const runReadiness = [...runsByLine.entries()]
    .map(([line, n]) => ({ line, n, ready: n >= MIN_RUNS_READY }))
    .sort((a, b) => b.n - a.n);

  // --- LEAD TIME over TfL — the moat, and the number that could prove us WRONG ---
  //
  // TfL's status feed is a LAGGING, human-curated indicator: someone in a control
  // room decides the line is now "severely delayed" and updates it. Train
  // movements are the LEADING indicator.
  //
  // TWO SIGNALS, and the second one matters more:
  //   1. DEGRADATION — trains running slower than normal.
  //   2. ABSENCE — trains not running at all.
  //
  // My first version only looked for (1), and would therefore have MISSED every
  // suspension: when a line is suspended, trains don't run slowly, they STOP.
  // The gap in the data IS the event. Absence is the stronger signal, and it is
  // the one that catches the incidents that matter most.
  //
  // CAVEAT: with only a few days of history the "expected rate" is thin, so this
  // is directional at best until the archive matures. Included anyway, because a
  // pit wall that cannot tell you you're wrong is decoration.
  const leadTimes: { line: string; cause: string; minutes: number; signal: string }[] = [];

  for (const inc of incidents) {
    const declaredMs = Date.parse(inc.start);
    const onLine = runs.filter((r) => r.line === inc.line);
    if (onLine.length < 100) continue;

    const dayKey = inc.start.slice(0, 10);
    const d0 = new Date(declaredMs);
    const weekend = d0.getUTCDay() === 0 || d0.getUTCDay() === 6;
    const hour = d0.getUTCHours();

    // Expected trains per 10 minutes, from the same line/hour/day-type on OTHER days.
    const perDay = new Map<string, number>();
    for (const r of onLine) {
      const day = r.dep.slice(0, 10);
      if (day === dayKey) continue;
      const d = new Date(r.dep);
      const isWe = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      if (isWe !== weekend || d.getUTCHours() !== hour) continue;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    if (perDay.size < MIN_BASELINE) continue;
    const expectedPer10 =
      ([...perDay.values()].reduce((a, b) => a + b, 0) / perDay.size) / 6;
    if (expectedPer10 < 1) continue;   // too sparse to detect a gap

    // Normal run-time envelope, for the degradation signal.
    const normal = onLine.filter((r) => {
      const t = Date.parse(r.dep);
      return t < declaredMs - 3600000 || t > Date.parse(inc.end) + 3600000;
    }).map((r) => r.sec);
    const p90 = normal.length >= 50 ? quantile(normal, 0.9) : null;

    // Walk the 40 minutes before TfL declared, in 10-minute windows.
    let firstAnomaly: { ms: number; signal: string } | null = null;
    for (let back = 40; back >= 10; back -= 10) {
      const winStart = declaredMs - back * 60000;
      const winEnd = winStart + 600000;
      const inWin = onLine.filter((r) => {
        const t = Date.parse(r.dep);
        return t >= winStart && t < winEnd;
      });

      // 1. ABSENCE — fewer than half the trains we'd expect.
      if (inWin.length < expectedPer10 * 0.5) {
        firstAnomaly = { ms: winStart, signal: 'trains missing' };
        break;
      }
      // 2. DEGRADATION — the median run time is way above normal.
      if (p90 && inWin.length >= 2) {
        const med = median(inWin.map((r) => r.sec));
        if (med > p90 * 1.4) {
          firstAnomaly = { ms: winStart, signal: 'trains slow' };
          break;
        }
      }
    }

    if (firstAnomaly) {
      leadTimes.push({
        line: inc.line,
        cause: inc.cause,
        minutes: Math.round((declaredMs - firstAnomaly.ms) / 60000),
        signal: firstAnomaly.signal,
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    coverage: {
      days: nDays,
      firstEvent: events[0]?.t ?? null,
      lastEvent: events[events.length - 1]?.t ?? null,
      events: events.length,
      incidents: incidents.length,
      runObservations: runs.length,
    },
    storage: {
      eventsBytes: dirBytes('events'),
      runtimesBytes: dirBytes('runtimes'),
      platformsBytes: dirBytes('platforms'),
      crowdingBytes: dirBytes('crowding'),
      perDayBytes: Math.round(
        (dirBytes('events') + dirBytes('runtimes')
          + dirBytes('platforms') + dirBytes('crowding')) / nDays),
    },
    readiness,
    runReadiness,
    minIncidents: MIN_INCIDENTS,
    minRunsReady: MIN_RUNS_READY,
    leadTime: {
      n: leadTimes.length,
      medianMinutes: leadTimes.length ? median(leadTimes.map((l) => l.minutes)) : null,
      samples: leadTimes.slice(-12),
    },
    worstLines: [...new Set(incidents.map((i) => i.line))].map((line) => {
      const list = incidents.filter((i) => i.line === line);
      return {
        line,
        incidents: list.length,
        minorMin: list.reduce((a, b) => a + b.minorMin, 0),
        severeMin: list.reduce((a, b) => a + b.severeMin, 0),
        suspendedMin: list.reduce((a, b) => a + b.suspendedMin, 0),
        medianMin: median(list.map((i) => i.minutes)),
      };
    }).sort((a, b) =>
      (b.suspendedMin * 3 + b.severeMin * 2 + b.minorMin)
      - (a.suspendedMin * 3 + a.severeMin * 2 + a.minorMin)),
    recent: incidents.slice(-25).reverse().map((i) => ({
      line: i.line, cause: i.cause, start: i.start, end: i.end,
      minutes: i.minutes,
      minorMin: i.minorMin, severeMin: i.severeMin, suspendedMin: i.suspendedMin,
      worstSev: i.worstSev, peakAfterMin: i.peakAfterMin,
      reason: i.reason,
      impact: trainsLost(runs, i),
      trace: i.trace.slice(0, 60),
      segments: [...new Set(i.segments.map(cleanSegment))].slice(0, 3),
    })),
  };

  mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
  writeFileSync(join(process.cwd(), 'docs', 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`Pit wall: ${events.length} events → ${incidents.length} incidents, ` +
    `${runs.length} run observations over ${nDays} day(s)`);
  console.log(`  storage ≈ ${(summary.storage.perDayBytes / 1e6).toFixed(2)} MB/day`);
  for (const r of readiness.slice(0, 8)) {
    console.log(`  ${r.ready ? '✅' : '⚠️'} ${r.cause.padEnd(17)} ${r.have}/${r.need}` +
      `${r.etaDays && !r.ready ? `  → ready in ~${r.etaDays[0]}–${r.etaDays[1]} days` : ''}`);
  }
  if (summary.leadTime.medianMinutes !== null) {
    console.log(`  📡 lead time over TfL: ~${summary.leadTime.medianMinutes} min ` +
      `(n=${summary.leadTime.n})`);
  }
}

main();
