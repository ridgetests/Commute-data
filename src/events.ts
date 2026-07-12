// Status → EVENTS, not snapshots.
//
// The old archiver wrote a poll every 15 min. Two problems: a 12-minute delay was
// invisible, and an incident's start/end could only be located to within a quarter
// hour — useless for a recovery model. And it stored LINE-level severity, when
// real TfL disruption is SEGMENTAL: "Minor delays between White City and Ealing
// Broadway... GOOD SERVICE on the rest of the line."
//
// v2: poll every 60s, write only when something CHANGES. Storage collapses (most
// minutes nothing happens), resolution goes to 1 minute, and you get exact
// incident start times, severity trajectories and recovery durations — grouped by
// CAUSE, which is what makes "how long will this last?" answerable.

export type Severity = number; // TfL statusSeverity: 10 = good, lower = worse

export type Cause =
  | 'signal-failure' | 'train-fault' | 'person-on-track' | 'trespass'
  | 'customer-incident' | 'staff-shortage' | 'weather' | 'fire-alert'
  | 'security-alert' | 'power-failure' | 'congestion' | 'engineering'
  | 'earlier-incident' | 'other' | 'none';

// Classify from TfL's free-text description. Ordered — first match wins, so more
// specific patterns come first.
const CAUSE_PATTERNS: [Cause, RegExp][] = [
  ['signal-failure', /signal(ling)?\s+(failure|fault|problem)/i],
  ['power-failure', /power\s+(failure|supply|fault)/i],
  ['train-fault', /(faulty|defective|broken[- ]down)\s+train|train\s+fault/i],
  ['person-on-track', /person\s+(on|under)\s+the?\s*track|casualty\s+on\s+the\s+track/i],
  ['trespass', /trespass/i],
  ['fire-alert', /fire\s+(alert|alarm)/i],
  ['security-alert', /(security\s+alert|police|suspicious)/i],
  ['customer-incident', /(customer\s+incident|ill\s+customer|passenger\s+taken\s+ill)/i],
  ['staff-shortage', /(shortage\s+of\s+(train\s+)?(operators|staff)|staff\s+shortage|industrial\s+action|strike)/i],
  ['weather', /(weather|flood|ice|snow|lightning|heat|leaves\s+on\s+the\s+line|high\s+winds)/i],
  ['engineering', /(engineering\s+work|planned\s+(closure|work)|improvement\s+work)/i],
  ['congestion', /congestion|service\s+recovery/i],
  ['earlier-incident', /earlier\s+(incident|signal|problem)/i],
];

export function classifyCause(text?: string): Cause {
  if (!text || !text.trim()) return 'none';
  for (const [cause, re] of CAUSE_PATTERNS) if (re.test(text)) return cause;
  return 'other';
}

// Pull "between X and Y" segment mentions out of the description. TfL's structured
// affectedStops/affectedRoutes are often EMPTY, so the prose is the fallback — and
// segment location is what stops the app crying wolf about the wrong end of a line.
export function extractSegments(text?: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /between\s+([A-Z][\w'&.\- ]+?)\s+and\s+([A-Z][\w'&.\/\- ]+?)(?=[,.;]|\s+(?:due|while|and|via)\b|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(`${m[1].trim()} — ${m[2].trim()}`);
  }
  return [...new Set(out)];
}

export interface LineState {
  line: string;
  sev: Severity;
  desc: string;              // e.g. "Severe Delays"
  reason?: string;           // TfL's full description text
  cause: Cause;
  segments: string[];        // affected sections, if any
  stops: string[];           // affectedStops naptan ids, when TfL provides them
}

// One line of the event log: a CHANGE, with the time it happened.
export interface ChangeEvent {
  t: string;                 // ISO timestamp
  line: string;
  from: Severity | null;     // null = first observation
  to: Severity;
  desc: string;
  cause: Cause;
  segments: string[];
  stops: string[];
  reason?: string;
}

export function toStates(apiLines: any[]): LineState[] {
  return apiLines.map((l) => {
    const st = l.lineStatuses?.[0] ?? {};
    const reason: string | undefined = st.reason ?? st.disruption?.description;
    const d = st.disruption ?? {};
    const stops: string[] = (d.affectedStops ?? [])
      .map((s: any) => s.naptanId)
      .filter(Boolean);
    // Structured routes when present; prose as fallback.
    const routed: string[] = (d.affectedRoutes ?? [])
      .map((r: any) => r.name)
      .filter(Boolean);
    const segments = routed.length ? routed : extractSegments(reason);
    return {
      line: l.id,
      sev: st.statusSeverity ?? 10,
      desc: st.statusSeverityDescription ?? 'Unknown',
      reason,
      cause: (st.statusSeverity ?? 10) === 10 ? 'none' : classifyCause(reason),
      segments,
      stops,
    };
  });
}

// Compare against the last known state; emit only what changed.
export function diff(
  prev: Map<string, LineState>,
  next: LineState[],
  now: Date,
): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const s of next) {
    const p = prev.get(s.line);
    const changed =
      !p ||
      p.sev !== s.sev ||
      p.cause !== s.cause ||
      p.segments.join('|') !== s.segments.join('|');
    if (!changed) continue;
    events.push({
      t: now.toISOString(),
      line: s.line,
      from: p ? p.sev : null,
      to: s.sev,
      desc: s.desc,
      cause: s.cause,
      segments: s.segments,
      stops: s.stops,
      reason: s.reason,
    });
  }
  return events;
}
