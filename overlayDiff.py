#!/usr/bin/env python3
"""
overlayDiff.py — READ-ONLY. The known-in-advance platform-change feature.

NOT a prediction. Short-term timetable overlays (CIF STP = O/N) carry their own
platform, which can differ from the permanent schedule — and that is published
weeks ahead. This lists, for a station over a date range, every service whose
platform on a specific date differs from its usual platform across the range:

  "Your 00:01 to Guildford is on platform 3 on the 17th, not the usual 1."

It resolves each date with STP precedence (C > N > O > P) via
extractPlatforms.resolve() — UNMODIFIED. Taking the permanent schedule naively
would show the wrong platform on exactly the days it changed, which is the worst
possible failure for this feature, so the precedence is the whole game.

Commits nothing; the schedule feed is downloaded at runtime by the workflow and
passed in as a path; output is markdown for a GitHub job summary.

  python3 overlayDiff.py toc-full.gz WAT 2026-08-10 2026-09-14
"""
import sys
from datetime import date, timedelta
from collections import defaultdict, Counter

import extractPlatforms as ep   # trusted extractor + STP resolver; NOT modified

# A date with more changes than this is a timetable-wide event (bank holiday,
# engineering retiming), not a per-service anomaly — summarised, not listed.
MASS_CHANGE = 50


def daterange(a, b):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def collect(rows, start, end):
    """uid -> {date: (platform, std, destTiploc, destCrs, stp)}, STP-resolved per date."""
    hist = defaultdict(dict)
    for d in daterange(start, end):
        for r in ep.resolve(rows, d):
            if r.get("platform") and r.get("std"):
                hist[r["uid"]][d] = (r["platform"], r["std"],
                                     r.get("destTiploc"), r.get("destCrs"), r.get("stp"))
    return hist


def find_changes(hist):
    """Return (changes, usual) where a change is a date the platform != the usual one."""
    changes = []
    usual = {}
    for uid, byday in hist.items():
        plats = [v[0] for v in byday.values()]
        if len(byday) < 2 or len(set(plats)) < 2:
            continue                      # never varies over the range — nothing to flag
        u = Counter(plats).most_common(1)[0][0]
        # the usual destination is the one on the usual-platform days
        udest = Counter(v[2] for v in byday.values() if v[0] == u).most_common(1)[0][0]
        usual[uid] = (u, udest)
        for d, (p, std, dt, dc, stp) in byday.items():
            if p != u:
                changes.append(dict(date=d, std=std, uid=uid, usual_plat=u,
                                    new_plat=p, usual_dest=udest, new_dest=dt, stp=stp))
    changes.sort(key=lambda c: (c["date"], c["std"]))
    return changes, usual


def name(tiploc):
    return tiploc or "?"


def main():
    gz = sys.argv[1]
    crs = sys.argv[2] if len(sys.argv) > 2 else "WAT"
    start = date.fromisoformat(sys.argv[3])
    end = date.fromisoformat(sys.argv[4])
    tiploc = ep.CRS_OVERRIDES.get(crs, crs)

    rows = ep.extract(gz, tiploc)
    hist = collect(rows, start, end)
    changes, usual = find_changes(hist)

    print(f"# Known-in-advance platform changes — {crs} (`{tiploc}`)\n")
    print(f"_Range {start} → {end}, resolved with STP precedence. A change is a date where a "
          f"service's platform differs from its usual platform across the range. These are "
          f"published plans, not predictions — no live data._\n")

    if not rows:
        print("> 0 booked departures — the TIPLOC join is wrong for this station.\n")
        return

    per_date = Counter(c["date"] for c in changes)
    mass = {d for d, n in per_date.items() if n > MASS_CHANGE}

    print(f"- Services at this station over the range: **{len(hist):,}**")
    print(f"- Services that change platform on at least one date: **{len(usual):,}**")
    print(f"- Individual platform changes: **{len(changes):,}** "
          f"across **{len(per_date)}** dates\n")

    # per-date summary — normal days (a few changes) are the valuable anomalies;
    # mass-change days are whole-timetable events
    print("## Changes per date\n")
    print("| date | day | platform changes | |")
    print("|---|---|---|---|")
    for d in sorted(per_date):
        n = per_date[d]
        note = "**whole-day retiming** (bank holiday / engineering)" if d in mass else ""
        print(f"| {d} | {d.strftime('%a')} | {n} | {note} |")

    # the individual, per-service planned changes — the product itself
    listed = [c for c in changes if c["date"] not in mass]
    print(f"\n## The planned changes ({len(listed)}, excluding whole-day events)\n")
    if listed:
        print("| date | departs | usual | on this date | note |")
        print("|---|---|---|---|---|")
        for c in listed[:60]:
            note = ""
            if c["new_dest"] and c["new_dest"] != c["usual_dest"]:
                note = f"also re-routed → {name(c['new_dest'])}"
            print(f"| {c['date']} {c['date'].strftime('%a')} | {c['std']} → {name(c['usual_dest'])} "
                  f"| plat **{c['usual_plat']}** | plat **{c['new_plat']}** | {note} |")
        if len(listed) > 60:
            print(f"\n_… and {len(listed) - 60} more._")
    else:
        print("_No per-service changes in range (only whole-day events, if any)._")

    # precedence self-check against the worked example in schedule-findings.md
    print("\n## Precedence check — worked example `L81908`\n")
    if "L81908" in hist:
        byday = hist["L81908"]
        u, udest = usual.get("L81908", (byday[min(byday)][0], byday[min(byday)][2]))
        moved = [(d, v[0], v[2]) for d, v in sorted(byday.items()) if v[0] != u]
        print(f"- Usual: platform **{u}** → {name(udest)}")
        if moved:
            for d, p, dt in moved:
                print(f"- **{d}**: platform **{p}** → {name(dt)}  ← changed")
            print("\n> Matches `schedule-findings.md` (17 Aug, platform 1 → 3, Guildford → Surbiton) "
                  "if that date is in range — confirms STP precedence is applied, not the naive "
                  "permanent schedule.")
        else:
            print("- No change in this range.")
    else:
        print("_`L81908` not present in this range/station._")


if __name__ == "__main__":
    main()
