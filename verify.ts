import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toStates, diff, classifyCause, extractSegments, type LineState } from './src/events';
import { RunTracker, type Prediction } from './src/runtimes';

// Proves the whole pipeline offline — no key, no network.

let bad = 0;
const ok = (label: string, cond: boolean, got?: unknown) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : `  — got: ${JSON.stringify(got)}`}`);
  if (!cond) bad++;
};

console.log('\nCause taxonomy');
ok('signal failure', classifyCause('an earlier signal failure at Liverpool Street') === 'signal-failure');
ok('person on track', classifyCause('a person on the track at Oval') === 'person-on-track');
ok('fire alert', classifyCause('while we respond to a fire alert at Stratford') === 'fire-alert');
ok('weather', classifyCause('due to adverse weather conditions') === 'weather');
ok('good service = none', classifyCause('') === 'none');

console.log('\nSegment extraction (the cry-wolf fix)');
const segs = extractSegments(
  'No service between Whitechapel and Shenfield and SEVERE DELAYS between Abbey Wood and Hayes & Harlington while we respond to a fire alert at Stratford.',
);
ok('finds both affected sections', segs.length === 2, segs);
ok('first is Whitechapel — Shenfield', segs[0] === 'Whitechapel — Shenfield', segs[0]);

console.log('\nEvent log (writes on change only)');
const raw = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/status.sample.json'), 'utf8'));
const states = toStates(raw);
const prev = new Map<string, LineState>();

const first = diff(prev, states, new Date('2026-07-11T18:00:00Z'));
ok('first poll logs all 3 lines', first.length === 3, first.length);
ok('central classified as signal-failure',
  first.find((e) => e.line === 'central')?.cause === 'signal-failure');
ok('central has a segment', (first.find((e) => e.line === 'central')?.segments.length ?? 0) > 0);
ok('elizabeth keeps affectedStops',
  (first.find((e) => e.line === 'elizabeth')?.stops.length ?? 0) === 2);

for (const s of states) prev.set(s.line, s);
const second = diff(prev, states, new Date('2026-07-11T18:01:00Z'));
ok('unchanged poll writes NOTHING', second.length === 0, second.length);

const worse: LineState[] = states.map((s) =>
  s.line === 'victoria' ? { ...s, sev: 6, cause: 'weather' as const } : s);
const third = diff(prev, worse, new Date('2026-07-11T18:02:00Z'));
ok('only the changed line is logged', third.length === 1 && third[0].line === 'victoria', third);
ok('records the transition 10 to 6', third[0]?.from === 10 && third[0]?.to === 6);

console.log('\nObserved run times + direction/platform');
const t = new RunTracker();
const base = Date.parse('2026-07-11T18:00:00Z');
const p = (station: string, eta: number): Prediction => ({
  vehicleId: '204', naptanId: station, lineId: 'victoria',
  expectedArrival: new Date(base + eta * 1000).toISOString(),
  platformName: 'Northbound - Platform 1',
  towards: 'Walthamstow Central', direction: 'inbound',
});

const r1 = t.ingest([p('VXL', 60), p('PCO', 180)], base);
ok('captures platform + direction', r1.platforms.length === 2, r1.platforms.length);
ok('direction is recorded', r1.platforms[0]?.towards === 'Walthamstow Central');

const r2 = t.ingest([p('PCO', 180)], base + 60_000);
ok('no run time yet (one arrival only)', r2.runs.length === 0, r2.runs.length);

const r3 = t.ingest([], base + 200_000);
ok('derives one observed run time', r3.runs.length === 1, r3.runs);
ok('Vauxhall to Pimlico = 120s', r3.runs[0]?.seconds === 120, r3.runs[0]?.seconds);
ok('run time carries direction', r3.runs[0]?.towards === 'Walthamstow Central');

console.log(bad === 0 ? '\n✓ all checks passed\n' : `\n✗ ${bad} FAILED\n`);
process.exitCode = bad ? 1 : 0;
