#!/usr/bin/env python3
"""
hdaImpact.py — build the cause-attributed IMPACT PRIOR from a Historic Delay
Attribution period file (Network Rail, OGL v3.0).

For each operator x cause-family it reports, per incident: how often it happens,
the typical and bad-day PfPI delay-minutes, and the trains affected. This is an
IMPACT prior ("when this kind of thing goes wrong, here's how bad it usually
gets") — NOT a recovery-duration curve: the HDA start/end fields are the
attribution window, not the disruption length, so duration is deliberately not
modelled here (the live event log is the honest source for the recovery curve).

Reads the raw HDA CSV (which is NOT committed — OGL lets us redistribute the
DERIVED model with attribution, and the file is 188 MB); writes a small bounded
model to docs/rail-impact.json (served over Pages, same-origin, for the app).

  python3 hdaImpact.py "Transparency 26-27 P02.csv"
"""
import csv, sys, json
from datetime import datetime, timezone
from collections import defaultdict

MIN_INCIDENTS = 20   # publishing bar: a cell needs this many incidents to speak

CAUSE = {
    'I': 'Infrastructure (track/signal/power)', 'J': 'Signalling / comms systems',
    'M': 'Fleet / rolling stock', 'N': 'Fleet (non-TRUST)',
    'O': 'Network Rail operations', 'Q': 'Network Rail non-operational',
    'T': 'Operator (TOC) operations', 'R': 'Station operations',
    'V': 'External — operator', 'X': 'External — Network Rail (weather/trespass/etc.)',
    'Y': 'Reactionary (knock-on)', 'Z': 'Unexplained / pending attribution',
    'P': 'Planned (excluded)', 'A': 'Freight terminal', 'F': 'Freight', 'D': 'Holding',
}
# Passenger TOC codes worth naming; others are published by code for now.
TOC = {'HY': 'South Western Railway'}
ATTRIBUTION = ("Contains information from Network Rail Infrastructure Limited, "
               "licensed under the Open Government Licence v3.0")


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0


def main():
    path = sys.argv[1]
    period = None
    # key each incident PER affected operator, so PfPI/trains are that operator's
    # own — an incident spans several TOCs via reactionary delay.
    unit = {}   # (incident, toc) -> {reason, pfpi, trains}
    with open(path, newline='') as fh:
        for row in csv.DictReader(fh):
            period = period or row.get("FINANCIAL_YEAR_PERIOD")
            n = row["INCIDENT_NUMBER"]
            toc = row["TOC_CODE"]
            if not n or not toc:
                continue
            k = (n, toc)
            d = unit.get(k)
            if d is None:
                d = unit[k] = {"reason": row["INCIDENT_REASON"], "pfpi": 0.0, "trains": 0}
            try:
                d["pfpi"] += float(row["PFPI_MINUTES"] or 0)
            except ValueError:
                pass
            d["trains"] += 1

    # aggregate per (toc, cause family) over (incident, toc) units
    agg = defaultdict(lambda: defaultdict(lambda: {"pfpi": [], "trains": []}))
    toc_total = defaultdict(int)
    inc = {k[0] for k in unit}   # distinct incidents, for the summary line
    for (n, toc), d in unit.items():
        cat = (d["reason"] or "?")[0]
        c = agg[toc][cat]
        c["pfpi"].append(d["pfpi"])
        c["trains"].append(d["trains"])
        toc_total[toc] += 1

    operators = {}
    for toc, cats in agg.items():
        rows = []
        for cat, c in cats.items():
            if len(c["pfpi"]) < MIN_INCIDENTS:
                continue
            rows.append({
                "cause": cat,
                "causeName": CAUSE.get(cat, f"code {cat}"),
                "incidents": len(c["pfpi"]),
                "sharePct": round(100 * len(c["pfpi"]) / toc_total[toc]),
                "pfpiP50": round(q(c["pfpi"], 0.5)),
                "pfpiP90": round(q(c["pfpi"], 0.9)),
                "trainsP90": q(c["trains"], 0.9),
            })
        if not rows:
            continue
        rows.sort(key=lambda r: -r["pfpiP90"])
        operators[toc] = {"name": TOC.get(toc, toc), "incidents": toc_total[toc],
                          "categories": rows}

    out = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": f"Network Rail Historic Delay Attribution ({period})",
        "licence": "OGL-3.0",
        "attribution": ATTRIBUTION,
        "minIncidents": MIN_INCIDENTS,
        "note": ("Cause-attributed impact prior: when an incident of this cause family "
                 "hits, typical (p50) and bad-day (p90) PfPI delay-minutes and trains "
                 "affected. NOT recovery duration — HDA start/end is the attribution "
                 "window. Use the live event log for the recovery curve."),
        "operators": operators,
    }
    import os
    os.makedirs("docs", exist_ok=True)
    with open("docs/rail-impact.json", "w") as f:
        json.dump(out, f, indent=1)
    print(f"period {period} · {len(inc):,} incidents · "
          f"{len(operators)} operators published (>= {MIN_INCIDENTS} incidents/cell)")


if __name__ == "__main__":
    main()
