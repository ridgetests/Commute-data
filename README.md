# commute-data

The moat. Three datasets nobody else is collecting, all of them **ephemeral** —
gone forever if not captured today.

## What it collects

**1. Disruption event log.** Polls every 60 seconds, writes **only when something
changes**. Most minutes nothing happens, so storage collapses rather than explodes
— and you get exact incident start times, the full severity trajectory, and precise
recovery durations, grouped by **cause**. That's the difference between "the Central
line was bad on Tuesday" and "signal failures at Liverpool Street typically peak at
22 minutes and clear in 35."

**2. Observed run times.** Every journey time in the app is currently a *geometric
estimate* — straight-line distance ÷ assumed speed. This derives what trains
**actually** do, by tracking each vehicle across stations. TfL does not publish
historical arrival times, so this cannot be recovered retrospectively.

**3. Platform + direction history.** Which platform a service uses, and which way
it's going ("Bakerloo northbound towards Harrow & Wealdstone"). Feeds two things:
the direction instruction the app currently lacks, and platform prediction later.

## Why segment-level matters

Real TfL disruption is segmental: *"Minor delays between White City and Ealing
Broadway... GOOD SERVICE on the rest of the line."* Treating that as line-wide makes
an app **cry wolf** — shouting about a problem at the wrong end of the line. The
event log captures affected sections (from `affectedRoutes`, or parsed from the
prose when TfL leaves that empty), so the app only alarms when trouble is on *your*
track.

## Setup

1. This repo must be **public** — Actions minutes are unlimited there, capped on
   private. Polling continuously would burn a private allowance.
2. Settings → Secrets and variables → Actions → new secret `TFL_APP_KEY`.
3. Actions tab → "Collect" → Run workflow.

Test offline first (no key needed): `npm install && npm run verify`

## Data

```
data/events/YYYY-MM-DD.jsonl      severity transitions, cause, affected segments
data/runtimes/YYYY-MM-DD.jsonl    observed segment run times, with direction
data/platforms/YYYY-MM-DD.jsonl   platform + direction per line/station
```

## Notes

- Four jobs a day, each ~5h40m at 60s cadence (GitHub caps a job at 6 hours). This
  beats short-interval cron, which GitHub runs unreliably.
- **Don't archive weather** — historical weather is retrievable retrospectively
  (Open-Meteo, free, no key). Join it to the event log by timestamp whenever you want.
- Attribution: "Powered by TfL Open Data" wherever this surfaces.
- GitHub pauses schedules after ~60 days of repo inactivity — commit something
  occasionally.
