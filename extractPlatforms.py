#!/usr/bin/env python3
"""
extractPlatforms.py — pull booked platforms out of the Network Rail SCHEDULE feed.

PROVEN against the real toc-full.gz (128 MB gzipped, 607,878 schedules) on
2026-08-09. Every field name here was read from the actual file, not guessed.

  python3 extractPlatforms.py toc-full.gz WATRLMN > wat_booked.json
  python3 extractPlatforms.py toc-full.gz WATRLMN --date 2026-08-10   # resolved

Streams the file line by line; peak memory is the output list, not the input.
"""
import gzip, json, sys
from collections import defaultdict
from datetime import date

# ─────────────────────────────────────────────────────────────────────────────
# THE TRAP THAT WILL COST YOU A DAY IF YOU MISS IT
#
# CORPUS and the feed's own TiplocV1 records both map CRS "WAT" to TIPLOC
# "WATRLOO". **"WATRLOO" appears in zero schedules.** The timetable uses
# "WATRLMN" (Waterloo Main), whose crs_code is null.
#
# So the obvious CRS -> TIPLOC join returns an empty result set, which looks
# exactly like "no data" rather than "wrong join". Verified: joining on
# WATRLOO gave 0 records; WATRLMN gave 12,543.
#
# Also: CRS "ALT" is ALTRINCHAM, not Alton. Alton is "AON" / TIPLOC "ALTON".
# ─────────────────────────────────────────────────────────────────────────────
CRS_OVERRIDES = {
    "WAT": "WATRLMN",   # NOT WATRLOO
    "AON": "ALTON",
    "SUR": "SURBITN",
    "CLJ": "CLPHMJC",   # CORPUS says CLPHMJN; schedules use CLPHMJC
    # Added after a run returned 0 booked departures for these CRS: the schedule
    # TIPLOC is not the CRS code. Read from the origin TIPLOC embedded in the
    # Darwin service IDs in data/rail (VXH -> VAUXHLM etc.), which are the same
    # TIPLOCs the schedules use for WAT/SUR. If any still returns 0, the feed's
    # own TiplocV1 records are the ground truth to check next.
    "VXH": "VAUXHLM",
    "WIM": "WIMBLDN",
    "RMD": "RICHMND",
}

# STP indicator precedence when several schedules cover the same date.
# C = cancelled, N = new short-term, O = overlay, P = permanent.
STP_PRECEDENCE = {"C": 0, "N": 1, "O": 2, "P": 3}


def extract(path, tiploc, location_type="LO"):
    """Every booked call at `tiploc`. location_type: LO origin, LI intermediate, LT terminus."""
    crs_of = {}
    rows = []
    with gzip.open(path, "rt") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue

            if "TiplocV1" in d:
                t = d["TiplocV1"]
                if t.get("crs_code"):
                    crs_of[t["tiploc_code"]] = t["crs_code"]
                continue

            if "JsonScheduleV1" not in d:
                continue
            s = d["JsonScheduleV1"]
            seg = s.get("schedule_segment") or {}
            locs = seg.get("schedule_location") or []
            if not locs:
                continue

            for l in locs:
                if l.get("tiploc_code") != tiploc:
                    continue
                if l.get("location_type") != location_type:
                    continue
                if location_type == "LO" and not l.get("public_departure"):
                    continue  # skip empty stock / non-public moves
                t = l.get("public_departure") or l.get("public_arrival") or ""
                dest = locs[-1]
                rows.append({
                    "uid": s["CIF_train_uid"],
                    "stp": s["CIF_stp_indicator"],
                    "days": s["schedule_days_runs"],      # "1111100" Mon..Sun
                    "from": s["schedule_start_date"][:10],
                    "to": s["schedule_end_date"][:10],
                    "std": f"{t[:2]}:{t[2:4]}" if t else None,
                    "platform": l.get("platform"),
                    "line": l.get("line"),
                    "destTiploc": dest.get("tiploc_code"),
                    "destCrs": crs_of.get(dest.get("tiploc_code")),
                    "toc": s.get("atoc_code"),
                    "cat": seg.get("CIF_train_category"),
                    "headcode": seg.get("signalling_id"),
                })
    return rows


def resolve(rows, d):
    """The timetable as it actually applies on date `d`, honouring STP precedence.

    Without this you double-count: a service can have a permanent schedule AND
    a short-term overlay covering the same day, with DIFFERENT platforms. The
    overlay wins — and an overlay that moves the platform is a known-in-advance
    anomaly, which is the whole point.
    """
    by_uid = defaultdict(list)
    for o in rows:
        if not (date.fromisoformat(o["from"]) <= d <= date.fromisoformat(o["to"])):
            continue
        if o["days"][d.weekday()] != "1":
            continue
        by_uid[o["uid"]].append(o)

    out = []
    for cands in by_uid.values():
        cands.sort(key=lambda x: STP_PRECEDENCE.get(x["stp"], 9))
        best = cands[0]
        if best["stp"] == "C":
            continue  # cancelled that day
        out.append(best)
    return sorted(out, key=lambda x: x["std"] or "")


if __name__ == "__main__":
    path = sys.argv[1]
    key = sys.argv[2]
    tiploc = CRS_OVERRIDES.get(key, key)
    rows = extract(path, tiploc)
    if "--date" in sys.argv:
        d = date.fromisoformat(sys.argv[sys.argv.index("--date") + 1])
        rows = resolve(rows, d)
    print(json.dumps(rows, indent=1))
