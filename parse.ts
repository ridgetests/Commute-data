// Pure, network-free. TfL status payload → one compact record per poll.
// Kept separate so the verifier can test it offline with no key and no fetch.

export interface LineStatusLite {
  id: string;
  sev: number;      // TfL statusSeverity: 10 = good service, lower = worse
  desc: string;     // e.g. "Good Service", "Severe Delays"
  reason?: string;  // only present when there's disruption
}

export interface StatusRecord {
  t: string;        // ISO timestamp of the poll
  lines: LineStatusLite[];
}

export function toRecord(apiLines: any[], now: Date = new Date()): StatusRecord {
  const lines: LineStatusLite[] = apiLines.map((l) => {
    const st = l.lineStatuses?.[0] ?? {};
    const rec: LineStatusLite = {
      id: l.id,
      sev: st.statusSeverity ?? 10,
      desc: st.statusSeverityDescription ?? "Unknown",
    };
    if (st.reason) rec.reason = st.reason;
    return rec;
  });
  return { t: now.toISOString(), lines };
}
