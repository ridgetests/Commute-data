import { classify, type Cause } from './taxonomy';
export { classify };
export type { Cause };
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


// Classify from TfL's free-text description. Ordered — first match wins, so more
// specific patterns come first.

export function classifyCause(text?: string): Cause {
  // Delegates to the ONE taxonomy. There used to be a second copy here, whose
  // weather regex had no word boundaries — so "ice" matched inside "serv-ICE",
  // and since every TfL message contains the word "service", almost EVERY
  // incident was classified as weather. One copy now, and it's audited on the
  // dashboard against TfL's own words.
  return classify(text);
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
