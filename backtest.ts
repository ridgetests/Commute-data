/**
 * backtest.ts — READ-ONLY. Changes nothing. Writes no files.
 *
 * Answers, from data already in the archive, for EVERY station at once:
 *
 *   1. If the app had said "usually platform 12", how often would it have been
 *      right?
 *   2. When the platform was NOT the usual one, how often would the app have
 *      confidently said the wrong thing? (The number that decides shippability.)
 *   3. How often is the platform unusual at all? (If it's never unusual, the
 *      anomaly feature has nothing to fire on. If it's always unusual, the
 *      station's platforming is discretionary and the prior is noise.)
 *   4. How early does Darwin actually reveal the platform, per station?
 *
 * Method: walk the archive forward in time. For each departure on day D, build
 * the model from days STRICTLY BEFORE D only, then score its prediction against
 * what actually happened. No future data leaks in.
 *
 * Deliberately imports NOTHING from the project — only node builtins.
 *
 * Run from the repo root:  npx tsx backtest.ts
 * Output is markdown, so it can be piped straight into a GitHub job summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER — the only place field names live.
//
// Leave a value as null to auto-detect. The chosen field is PRINTED at the top
// of the output. Check it against probe.ts. If it's wrong, set it here.
// ═══════════════════════════════════════════════════════════════════════════
const OVERRIDE: Record<string, string | null> = {
  timestamp: null,   // when the observation was made, ISO string or epoch ms
  crs: null,         // the station the board belongs to, e.g. "WAT"
  platform: null,    // platform value, may be null/absent when suppressed
  std: null,         // scheduled departure time, e.g. "18:42"
  dest: null,        // destination CRS or name
  etd: null,         // estimated departure / status — used to drop cancellations
};

// ═══════════════════════════════════════════════════════════════════════════
// PARAMETERS — tune by measurement, never to make a panel look alive.
// ═══════════════════════════════════════════════════════════════════════════
const RAIL_DIR = "data/rail";
const HALF_LIFE_DAYS = 21;      // aligned with platformModel.ts (read 2026-08-09)
const WARMUP_DAYS = 7;          // no predictions before this much history exists
const HEADLINE_MIN_N = 5;       // the existing publishing bar
const HEADLINE_MIN_SHARE = 0.7;
const N_SWEEP = [3, 5, 8, 12];
const SHARE_SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9];
const TOP_STATIONS = 25;

// ═══════════════════════════════════════════════════════════════════════════

type Json = any;

interface Obs {
  tsMs: number;
  crs: string;
  platform: string | null;
  std: string;
  dest: string;
  cancelled: boolean;
}

interface Instance {
  key: string;        // crs|std|dest|dayType
  crs: string;
  date: string;       // YYYY-MM-DD, service date
  dateMs: number;
  actual: string | null;
  firstPlatformMs: number | null;
  firstSeenMs: number;
  firstSeenHadPlatform: boolean;   // → right-censored lead time
  stdMs: number | null;
  cancelled: boolean;
}

function flatten(obj: Json, prefix = "", depth = 0): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 2) {
      Object.assign(out, flatten(v, key, depth + 1));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ── field auto-detection ───────────────────────────────────────────────────
function detectFields(sample: Record<string, Json>[]): Record<string, string | null> {
  const keys = new Map<string, { n: number; sample: Json[] }>();
  for (const rec of sample) {
    for (const [k, v] of Object.entries(rec)) {
      if (!keys.has(k)) keys.set(k, { n: 0, sample: [] });
      const e = keys.get(k)!;
      e.n++;
      if (e.sample.length < 20 && v != null) e.sample.push(v);
    }
  }

  const looksLikeTime = (vals: Json[]) =>
    vals.some((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) ||
    vals.some((v) => typeof v === "number" && v > 1_500_000_000_000);
  const looksLikeHHMM = (vals: Json[]) =>
    vals.filter((v) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v)).length >= vals.length * 0.6;
  const looksLikeCrs = (vals: Json[]) =>
    vals.filter((v) => typeof v === "string" && /^[A-Z]{3}$/.test(v)).length >= vals.length * 0.6;

  const score = (
    nameRe: RegExp,
    valueTest?: (vals: Json[]) => boolean
  ): string | null => {
    let best: string | null = null;
    let bestScore = -1;
    for (const [k, e] of keys) {
      let s = 0;
      if (nameRe.test(k)) s += 10;
      if (valueTest && e.sample.length && valueTest(e.sample)) s += 6;
      s += (e.n / sample.length) * 2;
      if (s > bestScore && s >= 8) {
        bestScore = s;
        best = k;
      }
    }
    return best;
  };

  return {
    timestamp: OVERRIDE.timestamp ?? score(/^(ts|time|at|when|observed|polled|seen|recorded)/i, looksLikeTime),
    crs: OVERRIDE.crs ?? score(/(^crs|station|stop|board|^from$|origin)/i, looksLikeCrs),
    platform: OVERRIDE.platform ?? score(/plat/i),
    std: OVERRIDE.std ?? score(/(std|sched|booked|planned)/i, looksLikeHHMM),
    dest: OVERRIDE.dest ?? score(/(dest|^to$|terminat)/i),
    etd: OVERRIDE.etd ?? score(/(etd|expected|estimated|status|cancel)/i),
  };
}

function toMs(v: Json): number | null {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function dayType(dateMs: number): string {
  const d = new Date(dateMs).getUTCDay();
  if (d === 0) return "sun";
  if (d === 6) return "sat";
  return "wd";
}

// ── load ───────────────────────────────────────────────────────────────────
function loadObservations(): { obs: Obs[]; fields: Record<string, string | null>; lines: number; files: number } {
  if (!fs.existsSync(RAIL_DIR)) {
    throw new Error(`\`${RAIL_DIR}\` not found. Run from the repo root.`);
  }
  const files = fs.readdirSync(RAIL_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length === 0) throw new Error(`No .jsonl files in \`${RAIL_DIR}\`.`);

  const records: Record<string, Json>[] = [];
  let lines = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(RAIL_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      lines++;
      try {
        records.push(flatten(JSON.parse(line)));
      } catch {
        /* skip */
      }
    }
  }

  const sample = records.length > 2000
    ? records.filter((_, i) => i % Math.floor(records.length / 2000) === 0)
    : records;
  const fields = detectFields(sample);

  const missing = ["timestamp", "crs", "platform", "std"].filter((k) => !fields[k]);
  if (missing.length) {
    throw new Error(
      `Could not identify required field(s): ${missing.join(", ")}. ` +
      `Run probe.ts and set them in the OVERRIDE block at the top of this file.`
    );
  }

  const obs: Obs[] = [];
  for (const r of records) {
    const tsMs = toMs(r[fields.timestamp!]);
    const crs = r[fields.crs!];
    const std = r[fields.std!];
    if (tsMs == null || typeof crs !== "string" || typeof std !== "string") continue;
    const rawPlat = r[fields.platform!];
    const etd = fields.etd ? String(r[fields.etd] ?? "") : "";
    obs.push({
      tsMs,
      crs,
      platform: rawPlat == null || rawPlat === "" ? null : String(rawPlat),
      std,
      dest: fields.dest ? String(r[fields.dest] ?? "?") : "?",
      cancelled: /cancel/i.test(etd),
    });
  }
  return { obs, fields, lines, files: files.length };
}

// ── group into service instances ───────────────────────────────────────────
function buildInstances(obs: Obs[]): Instance[] {
  const byInstance = new Map<string, Obs[]>();
  for (const o of obs) {
    const date = new Date(o.tsMs).toISOString().slice(0, 10);
    const id = `${o.crs}|${o.std}|${o.dest}|${date}`;
    if (!byInstance.has(id)) byInstance.set(id, []);
    byInstance.get(id)!.push(o);
  }

  const out: Instance[] = [];
  for (const [id, group] of byInstance) {
    group.sort((a, b) => a.tsMs - b.tsMs);
    const [crs, std, dest, date] = id.split("|");
    const dateMs = Date.parse(`${date}T00:00:00Z`);
    const withPlat = group.filter((g) => g.platform !== null);
    const stdMs = /^\d{2}:\d{2}$/.test(std) ? Date.parse(`${date}T${std}:00Z`) : null;

    out.push({
      key: `${crs}|${std}|${dest}|${dayType(dateMs)}`,
      crs,
      date,
      dateMs,
      actual: withPlat.length ? withPlat[withPlat.length - 1].platform : null,
      firstPlatformMs: withPlat.length ? withPlat[0].tsMs : null,
      firstSeenMs: group[0].tsMs,
      firstSeenHadPlatform: group[0].platform !== null,
      stdMs,
      cancelled: group.some((g) => g.cancelled),
    });
  }
  return out.sort((a, b) => a.dateMs - b.dateMs);
}

// ── the forward-walking model ──────────────────────────────────────────────
interface Prediction { platform: string; n: number; share: number }

function predict(
  history: { platform: string; dateMs: number }[],
  todayMs: number,
  minN: number,
  minShare: number
): Prediction | undefined {
  if (history.length === 0) return undefined;
  const weights = new Map<string, number>();
  let total = 0;
  for (const h of history) {
    const ageDays = (todayMs - h.dateMs) / 86_400_000;
    if (ageDays < 0) continue; // never look forward
    const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    weights.set(h.platform, (weights.get(h.platform) ?? 0) + w);
    total += w;
  }
  if (total === 0) return undefined;
  let best = "";
  let bestW = 0;
  for (const [p, w] of weights) if (w > bestW) { bestW = w; best = p; }
  const share = bestW / total;
  const n = history.length;
  if (n < minN || share < minShare) return undefined;
  return { platform: best, n, share };
}

interface Score {
  eligible: number;
  spoke: number;
  correct: number;
  confidentWrong: number;
}

function runSweep(
  instances: Instance[],
  minN: number,
  minShare: number,
  perStation?: Map<string, Score>
): Score {
  const history = new Map<string, { platform: string; dateMs: number }[]>();
  const score: Score = { eligible: 0, spoke: 0, correct: 0, confidentWrong: 0 };
  const firstMs = instances.length ? instances[0].dateMs : 0;

  for (const inst of instances) {
    const past = history.get(inst.key) ?? [];
    const warm = inst.dateMs - firstMs >= WARMUP_DAYS * 86_400_000;

    if (inst.actual !== null && !inst.cancelled && warm) {
      score.eligible++;
      const p = predict(past, inst.dateMs, minN, minShare);
      let st: Score | undefined;
      if (perStation) {
        if (!perStation.has(inst.crs)) {
          perStation.set(inst.crs, { eligible: 0, spoke: 0, correct: 0, confidentWrong: 0 });
        }
        st = perStation.get(inst.crs)!;
        st.eligible++;
      }
      if (p) {
        score.spoke++;
        if (st) st.spoke++;
        if (p.platform === inst.actual) { score.correct++; if (st) st.correct++; }
        else { score.confidentWrong++; if (st) st.confidentWrong++; }
      }
    }

    if (inst.actual !== null && !inst.cancelled) {
      past.push({ platform: inst.actual, dateMs: inst.dateMs });
      history.set(inst.key, past);
    }
  }
  return score;
}

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  return `${((a / b) * 100).toFixed(1)}%`;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
try {
  const { obs, fields, lines, files } = loadObservations();
  const instances = buildInstances(obs);
  const dates = [...new Set(instances.map((i) => i.date))].sort();

  console.log(`# Platform prior — back-test\n`);
  console.log(`_Read-only. No future data used: every prediction is built only ` +
    `from days strictly before the day it predicts._\n`);

  console.log(`## Fields used — CHECK THESE against probe.ts\n`);
  console.log(`| role | field chosen |`);
  console.log(`|---|---|`);
  for (const [role, f] of Object.entries(fields)) {
    console.log(`| ${role} | ${f ? `\`${f}\`` : "**not found**"} |`);
  }
  console.log(`\nIf any of these are wrong, everything below is wrong. Set them ` +
    `in the \`OVERRIDE\` block and re-run.\n`);

  console.log(`## Input\n`);
  console.log(`- Files: **${files}**, lines: **${lines.toLocaleString()}**, ` +
    `usable observations: **${obs.length.toLocaleString()}**`);
  console.log(`- Service instances: **${instances.length.toLocaleString()}**`);
  console.log(`- Date range: **${dates[0]} → ${dates[dates.length - 1]}** (${dates.length} days)`);
  console.log(`- Warm-up discarded: first ${WARMUP_DAYS} days · decay half-life: ${HALF_LIFE_DAYS} days\n`);

  if (dates.length < WARMUP_DAYS + 14) {
    console.log(`> ⚠️ Only ${dates.length} days of data. The numbers below are ` +
      `directional at best — re-run once there are 6+ weeks.\n`);
  }

  // ── how unusual is unusual? ──
  const byKey = new Map<string, string[]>();
  for (const i of instances) {
    if (i.actual === null || i.cancelled) continue;
    if (!byKey.has(i.key)) byKey.set(i.key, []);
    byKey.get(i.key)!.push(i.actual);
  }
  let totalObs = 0, offModal = 0;
  for (const plats of byKey.values()) {
    const counts = new Map<string, number>();
    for (const p of plats) counts.set(p, (counts.get(p) ?? 0) + 1);
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][1];
    totalObs += plats.length;
    offModal += plats.length - modal;
  }

  console.log(`## 1. Is the platform ever unusual?\n`);
  console.log(`Departures **not** on their most-common platform: **${pct(offModal, totalObs)}** ` +
    `(${offModal.toLocaleString()} of ${totalObs.toLocaleString()}).\n`);
  console.log(`- Near 0% → platforming is deterministic; the anomaly feature has ` +
    `nothing to fire on and the prior is trivially right.`);
  console.log(`- 2–15% → the feature is real: rare enough to be worth an ` +
    `interrupt, common enough to matter.`);
  console.log(`- Above ~30% → platforming is discretionary; a history-based prior ` +
    `is noise and Phase 5 (the inbound working) is the only honest route.\n`);

  // ── headline ──
  const perStation = new Map<string, Score>();
  const headline = runSweep(instances, HEADLINE_MIN_N, HEADLINE_MIN_SHARE, perStation);

  console.log(`## 2. Headline — at the current publishing bar (n≥${HEADLINE_MIN_N}, share≥${HEADLINE_MIN_SHARE})\n`);
  console.log(`| metric | value | meaning |`);
  console.log(`|---|---|---|`);
  console.log(`| Coverage | **${pct(headline.spoke, headline.eligible)}** | share of departures where the app would say anything at all |`);
  console.log(`| Accuracy when it speaks | **${pct(headline.correct, headline.spoke)}** | of those, how often it was right |`);
  console.log(`| **Confidently wrong** | **${pct(headline.confidentWrong, headline.spoke)}** | **the killer number — how often it would reassure you onto the wrong platform** |`);
  console.log(`\nEligible departures scored: ${headline.eligible.toLocaleString()}\n`);
  console.log(`> For the Constrained user, "confidently wrong" is the number that ` +
    `decides shippability. A 5% rate is roughly one bad evening a month, on the ` +
    `evening they were relying on it.\n`);

  // ── threshold sweep ──
  console.log(`## 3. Threshold sweep — pick by measurement, not by vibes\n`);
  console.log(`Each cell is **coverage / confidently-wrong**. Read down for the ` +
    `cost of a stricter bar; read across for the cost of demanding more agreement.\n`);
  let header = `| min n \\\\ min share |`;
  let divider = `|---|`;
  for (const s of SHARE_SWEEP) { header += ` ${s} |`; divider += `---|`; }
  console.log(header);
  console.log(divider);
  for (const n of N_SWEEP) {
    let row = `| **${n}** |`;
    for (const s of SHARE_SWEEP) {
      const r = runSweep(instances, n, s);
      row += ` ${pct(r.spoke, r.eligible)} / ${pct(r.confidentWrong, r.spoke)} |`;
    }
    console.log(row);
  }
  console.log(`\n> **Do not pick the cell with the best coverage.** Pick the ` +
    `loosest bar whose confidently-wrong rate you would be willing to defend to ` +
    `someone who missed a hospital appointment.\n`);

  // ── per station ──
  console.log(`## 4. Per station (all stations, one pass — no manual work)\n`);
  console.log(`| CRS | departures scored | coverage | confidently wrong |`);
  console.log(`|---|---|---|---|`);
  const stations = [...perStation.entries()].sort((a, b) => b[1].eligible - a[1].eligible);
  for (const [crs, s] of stations.slice(0, TOP_STATIONS)) {
    console.log(`| **${crs}** | ${s.eligible.toLocaleString()} | ${pct(s.spoke, s.eligible)} | ${pct(s.confidentWrong, s.spoke)} |`);
  }
  if (stations.length > TOP_STATIONS) {
    console.log(`\n_… and ${stations.length - TOP_STATIONS} more stations._\n`);
  }

  // ── disclosure lead ──
  console.log(`\n## 5. How early does Darwin actually reveal? (per station)\n`);
  const leadByStation = new Map<string, { uncensored: number[]; censored: number; total: number }>();
  for (const i of instances) {
    if (i.stdMs == null || i.cancelled) continue;
    if (!leadByStation.has(i.crs)) leadByStation.set(i.crs, { uncensored: [], censored: 0, total: 0 });
    const e = leadByStation.get(i.crs)!;
    e.total++;
    if (i.firstSeenHadPlatform) { e.censored++; continue; }
    if (i.firstPlatformMs == null) continue;
    const mins = (i.stdMs - i.firstPlatformMs) / 60_000;
    if (mins >= 0 && mins < 240) e.uncensored.push(mins);
  }

  console.log(`| CRS | n | median lead (uncensored) | censored | regime |`);
  console.log(`|---|---|---|---|---|`);
  for (const [crs] of stations.slice(0, TOP_STATIONS)) {
    const e = leadByStation.get(crs);
    if (!e || e.total < 20) {
      console.log(`| ${crs} | ${e?.total ?? 0} | — | — | **UNKNOWN** (n<20) |`);
      continue;
    }
    const med = median(e.uncensored);
    const censoredFrac = e.censored / e.total;
    let regime = "MIXED";
    if (censoredFrac >= 0.9) regime = "OPEN — nothing to build";
    else if (censoredFrac <= 0.2 && med !== null && med < 20) regime = "**SUPPRESSED — the product lives here**";
    console.log(`| ${crs} | ${e.total} | ${med === null ? "—" : `${med.toFixed(0)} min`} | ${(censoredFrac * 100).toFixed(0)}% | ${regime} |`);
  }

  console.log(`\n> **Censoring:** a "censored" instance already had a platform the ` +
    `first time we saw it, so its true lead is *unknown and longer* than measured — ` +
    `bounded by the poll window, not by the railway. Censored rows are excluded ` +
    `from the median rather than averaged in. A confident lead-time number that ` +
    `quietly includes them is the 1.27M-movements failure mode again: a big ` +
    `number hiding the fact that we weren't looking.\n`);

  console.log(`\n---\n`);
  console.log(`### Known simplifications (make these numbers pessimistic, not flattering)\n`);
  console.log(`- Day-type is a plain weekday/Sat/Sun split, not \`calendar.ts\`. ` +
    `Bank holidays are mis-bucketed.`);
  console.log(`- No change-point reset, so a timetable change pollutes the prior ` +
    `for ~${HALF_LIFE_DAYS} days. The real model handles this; this back-test doesn't.`);
  console.log(`- Decay half-life is a guess until aligned with \`platformModel.ts\`.`);
  console.log(`- Service date is taken from the observation timestamp, so ` +
    `post-midnight departures may split across two dates.`);
} catch (e) {
  console.log(`# Back-test could not run\n`);
  console.log(`\`\`\`\n${(e as Error).message}\n\`\`\`\n`);
  console.log(`Run \`npx tsx probe.ts\` from the repo root and read the ` +
    `"Likely field roles" table — then set the \`OVERRIDE\` block at the top of ` +
    `\`backtest.ts\`.\n`);
  process.exitCode = 1;
}
