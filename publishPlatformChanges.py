#!/usr/bin/env python3
"""
publishPlatformChanges.py — emit the overlay diff as a small JSON for the app.

Purely schedule-derived (Network Rail CIF, Open Government Licence v3.0), so it
carries the OGL attribution and is safe to publish. It does NOT touch the Darwin
archive, so the Darwin 1-year retention rule does not apply to this file.

Reuses overlayDiff.collect()/find_changes() and extractPlatforms — unmodified.
Writes JSON to stdout; the workflow redirects it to docs/platform-changes.json.

  python3 publishPlatformChanges.py toc-full.gz WAT,SUR,CLJ,WIM,VXH,RMD 2026-08-10 2026-09-21
"""
import sys, json
from datetime import date, datetime, timezone

import extractPlatforms as ep     # trusted; unmodified
import overlayDiff as od          # reuse collect() / find_changes()

ATTRIBUTION = ("Contains information from Network Rail Infrastructure Limited, "
               "licensed under the Open Government Licence v3.0")
LICENCE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"


def changes_for(gz, crs, start, end):
    tiploc = ep.CRS_OVERRIDES.get(crs, crs)
    rows = ep.extract(gz, tiploc)
    hist = od.collect(rows, start, end)
    changes, _usual = od.find_changes(hist)
    # A date where more than MASS_CHANGE services move is a whole-day retiming
    # (bank holiday / engineering), not per-service anomalies — record the dates
    # but don't list every row, so the file stays the useful "your usual train
    # moved" cases and bounded in size.
    from collections import Counter
    per_date = Counter(c["date"] for c in changes)
    mass = sorted(d.isoformat() for d, n in per_date.items() if n > od.MASS_CHANGE)
    out = []
    for c in changes:
        if c["date"].isoformat() in mass:
            continue
        row = {
            "date": c["date"].isoformat(),
            "std": c["std"],
            "destTiploc": c["usual_dest"],   # schedule TIPLOC — app maps to a name
            "usualPlatform": c["usual_plat"],
            "platform": c["new_plat"],
        }
        if c["new_dest"] and c["new_dest"] != c["usual_dest"]:
            row["reroutedToTiploc"] = c["new_dest"]
        out.append(row)
    return {"changes": out, "wholeDayRetimings": mass}


def main():
    gz = sys.argv[1]
    stations = [s.strip().upper() for s in sys.argv[2].split(",") if s.strip()]
    start = date.fromisoformat(sys.argv[3])
    end = date.fromisoformat(sys.argv[4])

    doc = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Network Rail SCHEDULE feed (CIF)",
        "licence": "OGL-3.0",
        "licenceUrl": LICENCE_URL,
        "attribution": ATTRIBUTION,
        "note": ("Planned platform changes vs each service's usual platform over the "
                 "range, STP-resolved. A published fact, not a prediction. destTiploc "
                 "is the schedule TIPLOC; resolve to a station name app-side."),
        "range": {"from": start.isoformat(), "to": end.isoformat()},
        "stations": {crs: changes_for(gz, crs, start, end) for crs in stations},
    }
    json.dump(doc, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
