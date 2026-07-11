# commute-data

The reliability moat. Every 15 minutes this logs TfL's live line status, so from
day one you're accumulating a historical record of what fails, where, and for how
long — the one asset in this whole project that compounds and can't be copied,
because it's *time* that's gone into it. Start it early; start it late and you've
lost the months.

## Put this in its OWN, PUBLIC repo — this matters

Not in the app repo. Two reasons:

1. **Cost.** GitHub Actions is free and unlimited on **public** repos. On a
   private repo you'd get ~2,000 free minutes a month, and polling every 15
   minutes burns through that. Public = free forever.
2. **It doubles as marketing.** This open dataset *is* the "most-delayed lines in
   London" data page from the plan (growth move #3). The data is TfL open data
   anyway, so publishing it costs you nothing and hands you a story every time
   the network falls over.

Keeping it separate also stops 96 bot commits a day from burying your app repo's
history.

## Setup (5 minutes, once)

1. Create a new **public** repo called `commute-data`. Upload these files.
2. Repo → Settings → Secrets and variables → Actions → New repository secret.
   Name it `TFL_APP_KEY`, paste your TfL key.
3. Repo → Actions tab → enable workflows if prompted → open "Archive TfL status"
   → "Run workflow" to fire one now and check it works.
4. After it runs, a `data/YYYY-MM-DD.jsonl` file appears with one line per poll.
   That's the moat starting to fill.

Test the parsing locally first if you like: `npm install && npm run verify`
(no key needed).

## Data shape

One JSON object per poll, appended to a dated JSONL file:

```json
{ "t": "2026-07-10T18:30:00.000Z",
  "lines": [ { "id": "central", "sev": 6, "desc": "Severe Delays", "reason": "..." } ] }
```

`sev` is TfL's severity: 10 = good service, lower = worse. Later, aggregate these
into per-line, per-time-of-day reliability stats and feed them into the engine's
`riskPenalties` seam — that's the "surest route" feature, fed by data you own.

## Honest caveats

- **GitHub cron isn't perfectly reliable.** Scheduled runs can lag under load or
  occasionally skip, and GitHub pauses schedules after ~60 days of no repo
  activity. Fine to start the moat; if the data ever becomes business-critical,
  move the poll to a tiny always-on cron (a cheap VPS or a free serverless timer)
  for guaranteed cadence.
- **Attribution.** This is TfL open data — carry "Powered by TfL Open Data"
  wherever you surface it, and don't imply it's official.
- **Extend later.** Add National Rail Darwin polling here too, the same way, when
  you want mainline reliability alongside the tube.
