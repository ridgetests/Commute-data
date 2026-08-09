#!/usr/bin/env python3
"""
bookedVsActual.py — READ-ONLY. Commits nothing, writes no repo files.

The decisive measurement: how often the Network Rail *booked* platform matches
the platform a train *actually* departed from at Waterloo (and other stations).

  booked  = the CIF schedule, STP-resolved for the day (extractPlatforms.py)
  actual  = the final platform Darwin showed, from data/rail/*.jsonl

The schedule feed is downloaded at runtime by the workflow and passed in as a
path. Nothing derived from it is written to the repo — output goes to stdout,
formatted as markdown for a GitHub job summary.

Darwin field names are read from the archive (ground truth, same as probe.ts):
  t (timestamp) · crs (station) · std (scheduled dep) · platform · destination

The booked side carries destination CRS/TIPLOC; Darwin carries destination
*names*. We bridge them by learning name -> CRS from the minutes where both
sides have exactly one service, then only compare minutes where that bridge
confirms it is the same train. This removes the "same minute, different train"
false mismatch.

STALENESS, STATED: a CIF daily file drops short-term overlays for dates already
in the past, so resolving an OLD archive date against TODAY's schedule can hand
back the permanent platform where an overlay actually moved it — a false
mismatch. That is why the report separates overlay-resolved from
permanent-resolved services, and highlights the RECENT window (archive dates
closest to the downloaded schedule), which is the trustworthy figure.

  python3 bookedVsActual.py toc-full.gz               # default station set
  python3 bookedVsActual.py toc-full.gz WAT,SUR,CLJ   # explicit
"""
import sys, os, json, glob
from datetime import date
from collections import defaultdict, Counter

import extractPlatforms as ep   # trusted extractor + STP resolver; NOT modified

RAIL_DIR = "data/rail"
DEFAULT_STATIONS = ["WAT", "SUR", "CLJ", "WIM", "VXH", "RMD"]
RECENT_DAYS = 7


def load_actuals(stations):
    """Per station, per (date, std): final (last-seen) platform + destination name(s)."""
    sset = set(stations)
    final = {c: {} for c in stations}          # crs -> (date,std) -> (t, platform)
    dests = {c: defaultdict(set) for c in stations}  # crs -> (date,std) -> {name}
    for f in sorted(glob.glob(os.path.join(RAIL_DIR, "*.jsonl"))):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                crs = r.get("crs")
                if crs not in sset:
                    continue
                std, plat, t = r.get("std"), r.get("platform"), r.get("t")
                if not (std and plat and t):
                    continue
                k = (t[:10], std)
                cur = final[crs].get(k)
                if cur is None or t > cur[0]:
                    final[crs][k] = (t, plat)
                if r.get("destination"):
                    dests[crs][k].add(r["destination"])
    return final, dests


def day_type(ds):
    wd = date.fromisoformat(ds).weekday()
    return "wd" if wd < 5 else ("sat" if wd == 5 else "sun")


def analyse(booked_rows, final_crs, dests_crs):
    """Return per-comparison rows and metadata for one station.

    Each comparison: (date, std, matched: bool, booked_plat, actual_plat, stp).
    """
    dates = sorted({k[0] for k in final_crs})
    # resolve the booked timetable applying on each archive date (STP precedence)
    resolved = {}
    for ds in dates:
        b = defaultdict(list)
        for row in ep.resolve(booked_rows, date.fromisoformat(ds)):
            if row.get("std") and row.get("platform"):
                b[row["std"]].append(
                    (row["platform"], row.get("destCrs"), row.get("destTiploc"), row.get("stp")))
        resolved[ds] = b

    # learn Darwin destination-name -> booked destCrs / destTiploc, from the
    # minutes where both sides are unambiguous (one booked service, one dest name)
    n2c, n2t = defaultdict(Counter), defaultdict(Counter)
    for ds in dates:
        for std, bl in resolved[ds].items():
            if len(bl) == 1 and len(dests_crs.get((ds, std), ())) == 1:
                name = next(iter(dests_crs[(ds, std)]))
                _, dc, dt, _ = bl[0]
                if dc:
                    n2c[name][dc] += 1
                if dt:
                    n2t[name][dt] += 1
    NC = {n: c.most_common(1)[0][0] for n, c in n2c.items()}
    NT = {n: c.most_common(1)[0][0] for n, c in n2t.items()}

    comps = []
    booked_only = ambiguous = rejected = 0
    for ds in dates:
        for std, bl in resolved[ds].items():
            key = (ds, std)
            if key not in final_crs:
                booked_only += 1          # booked, but Darwin never observed it (coverage gap)
                continue
            if len(bl) != 1 or len(dests_crs.get(key, ())) != 1:
                ambiguous += 1            # two trains this minute — can't cleanly attribute
                continue
            name = next(iter(dests_crs[key]))
            bp, dc, dt, stp = bl[0]
            ap = final_crs[key][1]
            same = (name in NC and dc and NC[name] == dc) or (name in NT and dt and NT[name] == dt)
            if not same:
                rejected += 1             # different train sharing the minute — not a real mismatch
                continue
            comps.append((ds, std, bp == ap, bp, ap, stp))
    recent = set(dates[-RECENT_DAYS:]) if len(dates) >= RECENT_DAYS else set(dates)
    meta = dict(booked_only=booked_only, ambiguous=ambiguous, rejected=rejected,
                dates=dates, recent=recent)
    return comps, meta


def rate(sub):
    m = sum(1 for c in sub if c[2])
    t = len(sub)
    return m, t, (100.0 * m / t if t else 0.0)


def verdict(pct):
    if pct >= 98:
        return "**>=98% — the booked platform can be asserted to users.**"
    if pct >= 85:
        return "**85-95% band — assert only where booked agrees with the empirical history.**"
    return "**<85% — treat as aspirational; fall back to anomaly-at-reveal + the overlay diff.**"


def render(crs, tiploc, booked_rows, comps, meta):
    print(f"\n## {crs}  (TIPLOC `{tiploc}`)\n")
    booked_with_plat = sum(1 for r in booked_rows if r.get("platform"))
    total_candidates = len(comps) + meta["ambiguous"] + meta["rejected"] + meta["booked_only"]
    m, t, p = rate(comps)
    match_rate = 100.0 * (len(comps) + meta["ambiguous"]) / total_candidates if total_candidates else 0.0

    print(f"- Booked departures in file: **{len(booked_rows):,}** "
          f"({booked_with_plat:,} with a platform)")
    print(f"- Cleanly comparable (one train that minute, destination-verified): **{t:,}**")
    print(f"- Excluded: {meta['booked_only']:,} not observed by Darwin (coverage gap) · "
          f"{meta['ambiguous']:,} shared-minute · {meta['rejected']:,} different-train")
    print(f"- Join match rate (found an actual on both sides): **{match_rate:.0f}%** "
          f"— _a low rate here means the join key is wrong, not that the data is bad_\n")

    if t == 0:
        print("> No comparable services — check the TIPLOC join.\n")
        return

    print(f"### booked == actual: **{p:.1f}%**  ({m:,}/{t:,})\n")

    rm, rt, rp = rate([c for c in comps if c[0] in meta["recent"]])
    if rt:
        print(f"- **Recent window** (last {RECENT_DAYS} archive days, contemporaneous with the "
              f"downloaded schedule — the trustworthy figure): **{rp:.1f}%** ({rm:,}/{rt:,})")

    # staleness self-check: overlay-resolved services carry a fresh short-term record
    ov = [c for c in comps if c[5] in ("O", "N")]
    pe = [c for c in comps if c[5] == "P"]
    if ov:
        _, ot, op = rate(ov)
        print(f"- Overlay-resolved (short-term record present): **{op:.0f}%** ({ot:,}) · "
              f"permanent-resolved (incl. dropped-overlay fallbacks): {rate(pe)[2]:.0f}% ({len(pe):,})")
    print()

    # by day type
    print("| day type | booked == actual |")
    print("|---|---|")
    for dt_ in ("wd", "sat", "sun"):
        sub = [c for c in comps if day_type(c[0]) == dt_]
        if sub:
            mm, tt, pp = rate(sub)
            print(f"| {dt_} | {pp:.0f}% ({mm}/{tt}) |")

    # by hour
    print("\n| hour | booked == actual |")
    print("|---|---|")
    byh = defaultdict(list)
    for c in comps:
        byh[c[1][:2]].append(c)
    for h in sorted(byh):
        mm, tt, pp = rate(byh[h])
        print(f"| {h}:xx | {pp:.0f}% ({mm}/{tt}) |")

    # where they differ
    mis = Counter((c[3], c[4]) for c in comps if not c[2])
    if mis:
        print("\n**Where booked and actual differ (booked -> actual : count):**\n")
        for (bp, ap), n in mis.most_common(8):
            print(f"- booked `{bp}` -> actual `{ap}`  x{n}")

    print(f"\n> {verdict(rp if rt else p)}\n")


def main():
    if len(sys.argv) < 2:
        print("usage: bookedVsActual.py <toc-full.gz> [CRS,CRS,...]")
        raise SystemExit(2)
    gz = sys.argv[1]
    stations = sys.argv[2].split(",") if len(sys.argv) > 2 else DEFAULT_STATIONS
    final, dests = load_actuals(stations)

    print("# Booked vs actual platform\n")
    print("_Read-only. Network Rail schedule downloaded at runtime; nothing committed. "
          "Booked = CIF timetable, STP-resolved. Actual = final Darwin platform. "
          "Only single-train, destination-verified minutes are compared._\n")

    for crs in stations:
        tiploc = ep.CRS_OVERRIDES.get(crs, crs)
        rows = ep.extract(gz, tiploc)          # trusted; scans the file once per station
        comps, meta = analyse(rows, final[crs], dests[crs])
        render(crs, tiploc, rows, comps, meta)


if __name__ == "__main__":
    main()
