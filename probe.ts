/**
 * probe.ts — READ-ONLY. Changes nothing.
 *
 * Prints the actual shape of the rail event log and the platform model, so that
 * backtest.ts (and anything after it) is written against ground truth rather
 * than a guess. Run this FIRST. If backtest.ts picks the wrong fields, the
 * answer is in this output.
 *
 * Deliberately imports NOTHING from the project — only node builtins. It cannot
 * break on a wrong import path.
 *
 * Run from the repo root:  npx tsx probe.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const RAIL_DIRS = ["data/rail", "data/events", "data/crowding"];
const MODEL_DIR = "data/model";
const SAMPLE_LINES = 400;

type Json = any;

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

function listFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

console.log("# Schema probe\n");
console.log(`Run from: \`${process.cwd()}\`\n`);

for (const dir of RAIL_DIRS) {
  const files = listFiles(dir, ".jsonl");
  console.log(`\n## \`${dir}/\`\n`);

  if (files.length === 0) {
    console.log(`No \`.jsonl\` files found. (If this directory is gitignored ` +
      `by design — e.g. \`data/runtimes\`, \`data/platforms\`, \`data/raw\` — ` +
      `that is expected, not an outage.)\n`);
    continue;
  }

  let totalLines = 0;
  const sample: Record<string, Json>[] = [];
  const rawSamples: string[] = [];

  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    totalLines += lines.length;
    // sample from the head and tail of each file — schemas drift over time
    const picks = [
      ...lines.slice(0, 3),
      ...lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 2),
      ...lines.slice(-2),
    ];
    for (const line of picks) {
      if (sample.length >= SAMPLE_LINES) break;
      try {
        const parsed = JSON.parse(line);
        sample.push(flatten(parsed));
        if (rawSamples.length < 3) rawSamples.push(line);
      } catch {
        /* ignore unparseable line in probe */
      }
    }
  }

  console.log(`Files: **${files.length}**  ·  Lines: **${totalLines.toLocaleString()}**`);
  console.log(`First: \`${path.basename(files[0])}\`  ·  Last: \`${path.basename(files[files.length - 1])}\`\n`);

  // key frequency + example values
  const keys = new Map<string, { n: number; types: Set<string>; examples: Set<string> }>();
  for (const rec of sample) {
    for (const [k, v] of Object.entries(rec)) {
      if (!keys.has(k)) keys.set(k, { n: 0, types: new Set(), examples: new Set() });
      const e = keys.get(k)!;
      e.n++;
      e.types.add(typeOf(v));
      if (e.examples.size < 5 && v !== null && v !== undefined) {
        e.examples.add(JSON.stringify(v).slice(0, 40));
      }
    }
  }

  console.log(`### Fields (from ${sample.length} sampled records)\n`);
  console.log(`| field | present | type | example values |`);
  console.log(`|---|---|---|---|`);
  const sorted = [...keys.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, e] of sorted) {
    const pct = Math.round((e.n / sample.length) * 100);
    console.log(
      `| \`${k}\` | ${pct}% | ${[...e.types].join("/")} | ${[...e.examples].join(", ")} |`
    );
  }

  // heuristic role guesses — these are the ones backtest.ts needs
  const roles: Record<string, RegExp> = {
    timestamp: /^(ts|time|at|when|observed|polled|seen|recorded)/i,
    station_crs: /(crs|station|stop|from|origin|board)/i,
    platform: /plat/i,
    scheduled_dep: /(std|sched|booked|planned|dep)/i,
    destination: /(dest|to|toc?loc|terminat)/i,
    estimated_dep: /(etd|expected|estimated|status|late|delay|cancel)/i,
    service_id: /(rid|uid|serviceid|trainid|headcode|rsid|id)$/i,
  };

  console.log(`\n### Likely field roles — CHECK THESE\n`);
  console.log(`| role | candidate fields (best first) |`);
  console.log(`|---|---|`);
  for (const [role, re] of Object.entries(roles)) {
    const matches = sorted
      .filter(([k]) => re.test(k))
      .slice(0, 4)
      .map(([k]) => `\`${k}\``);
    console.log(`| ${role} | ${matches.length ? matches.join(" · ") : "**none found**"} |`);
  }

  console.log(`\n### Raw sample lines (verbatim)\n`);
  for (const r of rawSamples) {
    console.log("```json");
    console.log(r.slice(0, 600));
    console.log("```");
  }
}

// ---- models ----
console.log(`\n## \`${MODEL_DIR}/\`\n`);
const models = listFiles(MODEL_DIR, ".json");
if (models.length === 0) {
  console.log("No model files found.\n");
} else {
  for (const m of models) {
    const stat = fs.statSync(m);
    console.log(`### \`${path.basename(m)}\` (${(stat.size / 1024).toFixed(1)} KB)\n`);
    try {
      const parsed = JSON.parse(fs.readFileSync(m, "utf8"));
      const topKeys = Object.keys(parsed).slice(0, 8);
      console.log(`Top-level keys: ${topKeys.map((k) => `\`${k}\``).join(", ")}` +
        `${Object.keys(parsed).length > 8 ? ` … (${Object.keys(parsed).length} total)` : ""}\n`);
      const firstKey = Object.keys(parsed)[0];
      if (firstKey !== undefined) {
        console.log("One entry, verbatim:\n");
        console.log("```json");
        console.log(JSON.stringify({ [firstKey]: parsed[firstKey] }, null, 2).slice(0, 900));
        console.log("```");
      }
    } catch (e) {
      console.log(`Could not parse: ${(e as Error).message}\n`);
    }
  }
}

console.log(`\n---\n`);
console.log(`**Next:** compare the "Likely field roles" table above against the ` +
  `\`FIELDS\` block that \`backtest.ts\` prints at the top of its output. If they ` +
  `disagree, set the overrides in \`backtest.ts\` and re-run. Do not assume.\n`);
