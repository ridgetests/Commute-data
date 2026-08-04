# Getting it live

Twenty minutes, two things to stand up. Do them in order.

---

## 1 · API key

console.anthropic.com → API keys → create. Put a small credit on the account.
Copy the key somewhere safe — you see it once.

## 2 · The worker

Terminal on the MacBook:

```bash
mkdir ~/planner && cd ~/planner
npm install -g wrangler
wrangler login
```

That opens a browser to sign into Cloudflare. Free account, no card needed.

Copy `worker.js` into `~/planner`, then create `wrangler.toml` next to it:

```toml
name = "trip-planner"
main = "worker.js"
compatibility_date = "2026-08-03"
```

Then:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

Paste the key at the prompt, press enter. Then:

```bash
wrangler deploy
```

It prints a URL like `https://trip-planner.yourname.workers.dev`. **Copy it.**

## 3 · Point the page at it

Open `generator.html` in a text editor. First line of the script:

```js
const ENDPOINT='/api/plan';   /* <-- your worker URL */
```

Change to your URL. Save. **Double-click the file** — it opens and works.

## 4 · Put it where friends can reach it

dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets.
Drag `generator.html` in, rename it `index.html`, deploy. You get a shareable URL.

## Optional · Flickr for better photographs

The picture chain runs on Wikimedia Commons alone without this. Adding Flickr
gets you human-scale shots Commons is weak at.

flickr.com/services/apps/create → get a non-commercial key, then:

```bash
wrangler secret put FLICKR_API_KEY
wrangler deploy
```

**The free key is personal and non-commercial.** A commercial key is a separate,
individually reviewed application. Leave it unset and the chain skips that step.

---

## If it breaks

| What you see | What it is |
|---|---|
| `returned 401` | Key didn't save. Re-run `wrangler secret put ANTHROPIC_API_KEY` |
| `returned 502` | Open the worker URL in a browser — should say "POST only" |
| Nothing on the button | Browser console (⌥⌘I). Usually a trailing slash on the endpoint |
| "something unreadable" | Model wrapped its JSON in prose. Run again |
| No photographs | Normal on obscure places. The chain returns nothing rather than something wrong |

**Watch the spend.** console.anthropic.com → Usage. Each run is roughly 3–6p.
If the page gets shared widely that's the thing that could surprise you — worth
adding a rate limit before it goes beyond friends.

---

## What to judge, in order

1. **The reading line.** Does it correctly name what your family is actually
   after? If that's wrong nothing below it can be right.
2. **Did it reach past the obvious?** Bohinj and Bled leading means the prompt
   needs sharpening.
3. **Does it send you back?** Anything on your been-there list, or its immediate
   neighbour, is a failure.
4. **Do the risks carry a time, a threshold or an action?** "It can get busy" is
   a bare caveat and worse than nothing.
5. **Anything invented?** Places, figures, age limits stated as fact. You are
   currently the only check.

**Then change one thing and re-run.** Swap "best trip, price second" for
"cheapest that works". If the three barely move, the personalisation is
decorative — which is exactly what you found in every competitor.
