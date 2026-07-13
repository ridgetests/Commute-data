import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// TIME, DONE PROPERLY.
//
// Three bugs lived here, and two of them were silently corrupting data.
//
// 1. BRITISH SUMMER TIME. Both models bucketed by getUTCHours(). For seven
//    months of the year every time band is shifted by an hour — so the 08:00
//    peak lands in the 07:00 bucket all summer, and every band is a blend of two
//    different hours. Not a subtlety; just wrong.
//
// 2. BANK HOLIDAYS. A bank holiday Monday runs a reduced, Sunday-ish service.
//    Bucketed as a normal weekday it does double damage: it corrupts the weekday
//    pattern AND gets a weekday prediction it will not honour.
//
// 3. What we DON'T claim: that a bank holiday equals a Sunday. Some operators run
//    a Saturday service, some a Sunday one, some something of their own. So bank
//    holidays get their OWN bucket. There are only ~8 a year, so the model will
//    rarely be confident about them — and that is the correct outcome. It says
//    nothing rather than guessing.

const GOV_UK = 'https://www.gov.uk/bank-holidays.json';
const CACHE = join(process.cwd(), 'data', 'reference', 'bank-holidays.json');

export type DayType = 'wd' | 'we' | 'bh';

// London local time, properly. Intl knows about BST; we don't have to.
export function londonParts(iso: string | Date): { date: string; hour: number; dow: number } {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const DOW: Record<string, number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // Intl renders midnight as "24" in some locales — normalise it.
    hour: Number(parts.hour) % 24,
    dow: DOW[parts.weekday as string] ?? 0,
  };
}

let holidays: Set<string> | null = null;

export function loadBankHolidays(): Set<string> {
  if (holidays) return holidays;
  if (existsSync(CACHE)) {
    try {
      holidays = new Set(JSON.parse(readFileSync(CACHE, 'utf8')) as string[]);
      return holidays;
    } catch { /* fall through */ }
  }
  holidays = new Set();
  return holidays;
}

// Refresh from gov.uk's official feed. Free, no key, no auth. Cached to the repo
// so a network blip can't corrupt the day-typing — if the fetch fails we keep
// using the cache, and if there's no cache we treat every day as normal AND SAY
// SO, rather than silently mislabelling a bank holiday as a Tuesday.
export async function refreshBankHolidays(): Promise<{ ok: boolean; n: number }> {
  try {
    const res = await fetch(GOV_UK);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json() as any;
    const dates: string[] = (j['england-and-wales']?.events ?? [])
      .map((e: any) => String(e.date));
    if (dates.length === 0) throw new Error('no events');
    mkdirSync(join(CACHE, '..'), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(dates));
    holidays = new Set(dates);
    return { ok: true, n: dates.length };
  } catch {
    const cached = loadBankHolidays();
    return { ok: false, n: cached.size };
  }
}

export function dayType(iso: string | Date): DayType {
  const { date, dow } = londonParts(iso);
  if (loadBankHolidays().has(date)) return 'bh';
  return dow === 0 || dow === 6 ? 'we' : 'wd';
}

// The time band a model cell belongs to: day-type × London-local hour.
export function bandOf(iso: string | Date): string {
  const { hour } = londonParts(iso);
  return `${dayType(iso)}-${String(hour).padStart(2, '0')}`;
}

export const dateOf = (iso: string | Date): string => londonParts(iso).date;
