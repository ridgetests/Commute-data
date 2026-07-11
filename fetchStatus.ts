import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { toRecord } from "./parse";

// One poll: fetch live status, append a compact record to data/<date>.jsonl.
// Dated files keep each day small so git diffs stay sane over months.

const MODES = process.env.MODES ?? "tube,dlr,overground,elizabeth-line";

async function main() {
  const key = process.env.TFL_APP_KEY;
  if (!key) {
    console.error("Set TFL_APP_KEY (a GitHub Actions secret in the real run).");
    process.exit(1);
  }

  const url = `https://api.tfl.gov.uk/Line/Mode/${MODES}/Status?app_key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`TfL ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const record = toRecord(await res.json());
  const dir = join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${record.t.slice(0, 10)}.jsonl`), JSON.stringify(record) + "\n");

  const issues = record.lines.filter((l) => l.sev < 10).length;
  console.log(`${record.t} · ${record.lines.length} lines logged · ${issues} with issues`);
}

main();
