import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRecord } from "./src/parse";

// Proves the parse works with no key and no network — same code the live poll uses.
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/status.sample.json"), "utf8"),
);

const rec = toRecord(fixture, new Date("2026-07-10T18:30:00Z"));
console.log(JSON.stringify(rec, null, 2));

const ok =
  rec.lines.length === 3 &&
  rec.lines[1].sev === 6 &&
  !!rec.lines[1].reason &&
  rec.t.startsWith("2026-07-10");

console.log(ok ? "\n✓ parse verified" : "\n✗ parse failed");
process.exitCode = ok ? 0 : 1;
