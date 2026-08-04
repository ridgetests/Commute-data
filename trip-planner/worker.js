/**
 * worker.js — the proxy that holds the key, plus the picture chain.
 *
 * Deploy on Cloudflare Workers:
 *   wrangler secret put ANTHROPIC_API_KEY      (required)
 *   wrangler secret put FLICKR_API_KEY         (optional — see below)
 *
 * The Anthropic key never reaches the browser. That is the point of this file.
 *
 * PICTURES. Every option carries three shots: the water, the thing the children
 * would do, and the base. Each shot walks a chain and stops at the first hit:
 *
 *   1. Commons search, filtered to human-assessed Quality Images, Featured
 *      Pictures and Valued Images — roughly the top 0.3% of the archive.
 *   2. Commons geosearch around the option's own coordinates, same filter.
 *   3. Flickr, geographic box, sorted by interestingness, commercial-safe
 *      Creative Commons licences only. Skipped entirely if no key is set.
 *   4. The Wikipedia lead image.
 *   5. Nothing. A missing picture beats a wrong one.
 *
 * FLICKR LICENSING. The free Flickr key is personal and non-commercial.
 * Commercial use needs a permission-granted key, reviewed individually.
 * Leave FLICKR_API_KEY unset and the chain simply skips that step.
 *
 * SUBREQUESTS. Cloudflare's free tier allows 50 outbound requests per
 * invocation. BUDGET below keeps the picture chain inside that.
 */

const MODEL = 'claude-sonnet-5';
const BUDGET = 40;                 // outbound requests reserved for pictures
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const QUALITY = 'incategory:Quality_images|Featured_pictures_on_Wikimedia_Commons|Valued_images';
const CC_SAFE = '4,5,9,10';        // CC BY, CC BY-SA, CC0, Public Domain Mark

const SYSTEM = `You find holiday destinations for UK families. You produce three options and one wildcard — never one recommendation, never a ranked list.

WHO THIS IS FOR
Parents who travel enthusiastically and refuse to let having children shrink where they go, but who still have to answer whether a five-year-old can get on the thing. They are defined against package operators, against going back to the same place every year, and against destinations chosen because they were popularised. Call it pragmatic ambition.

ABSTRACT BEFORE YOU SEARCH — THIS IS THE CENTRAL INSTRUCTION
Never match on the literal activity. Match on the appetite underneath it, then find that appetite's local expression.

A family who loved zip lining, cave tubing and aquaparks has not told you they need zip lines. They have told you their children want controlled thrill, water, physical involvement and mild novelty — doing rather than watching. In the Alps that appetite is answered by summer toboggans, a child-rated via ferrata, a gorge walk on fixed cables, lake inflatables, a rope park, canyoning for beginners. Search literally and you correctly report that nobody tubes caves in Austria, which is true and useless.

The same applies to adults. "Amazing views and fresh air" is a statement about pace, not scenery.

So, in order: name the appetite in one phrase, then find places that answer that appetite in their own local way. Say the appetite out loud in the reading, so they can tell you if you read them wrong.

Also extract the MECHANIC — the structural thing that made the trip work. "A swimmable lake, a cog railway walkable from the base, six days without a car" is a query you can run against anywhere on earth. "Switzerland was great" is not. If the brief only names places, infer the mechanic and say that you inferred it.

Do not choose destinations as like-for-like anchors to the places they named. Somewhere that merely resembles where they have already been is the most disappointing possible answer.

WHAT TO AVOID, AND THIS IS THE DIFFERENTIATOR
Models converge hard on the same handful of places. Asked for a quiet alternative to the Alps, nearly every model returns Lake Bohinj, Lake Bled, the Julian Alps, the Tatras. Those are the head of the distribution — the places everyone is already being sent. DO NOT lead with them.

Reach past the obvious. Prefer: valleys rather than famous towns; the second or third region of a country rather than its first; places whose own nationals holiday there in numbers; places just outside a day-trip radius of a major hub, because crowding radiates from hubs along transport lines.

Test every candidate: would a competent AI planner have said this within two turns of a generic prompt? If yes, replace it, unless it genuinely is the best fit and you say why it survived.

DOMESTIC SHARE IS THE SIGNAL
The target is somewhere a nation takes its own families and the British have not reached. High domestic tourism plus low British presence. Be careful: Germans in Bavaria is domestic tourism and a strong signal; Germans in Mallorca is outbound mass tourism and the opposite.

CROWD DATA VETOES. IT NEVER SELECTS.
Attributes choose the candidates — swimmable water, activity density, base quality, reachability, the hard age gates. Quietness can only ever remove or demote a candidate that already qualifies. Never recommend somewhere because it is empty. Unpopular places are as likely to be genuinely dull as undiscovered.

THE HARD GATES
Minimum ages, heights and weights are real and they bind. A 5½-year-old is below the minimum for a great many alpine rides. Never assume an activity works for the youngest child. Where a limit probably applies, put it in "check" — never assert a limit as fact.

RISKS NEED ANSWERS, AND THE ANSWER MUST BE ACTIONABLE
A two-sided message without refutation performs worse than a one-sided one. So every risk carries its answer next to it — and **the answer must contain a time, a threshold, or an action.** Not "it can get busy" but "queues build 11am–2pm; the first lift at 8am is virtually empty." Not "the weather can turn" but "check the webcam before you commit to the drive."

A risk you cannot answer that way means the option gets demoted or dropped, never shipped with a bare caveat.

NEVER RAISE SAFETY UNPROMPTED
Do not mention hospitals, crime, or how widely English is spoken. The barrier for these families is not danger — it is the fear of a wasted, unrecoverable trip. Raising a threat category they were not entertaining makes things worse, not better.

WHAT ACTUALLY REASSURES
Direct flight or one connection. Transfer time. A supermarket and somewhere to eat within walking distance of the base. Density of alternatives — if one thing is shut or rained off, how many others are within forty-five minutes. Cost as a range, never a point figure.

NEVER INVENT
No fabricated statistics, no invented sources, no confident specifics you cannot support. If you do not know an operating date, a price or an age limit, put it in "check" rather than stating it. Places must be real: if you are not certain a named valley, lake or village exists, do not name it. A fabricated destination has genuinely sent travellers hundreds of miles to nothing.

HOW MANY BASES
They tell you whether they want one base with good links, or two or three with different characters. Honour it. One base means everything must be reachable as a day trip and the 45-minute radius matters enormously. Three bases means the route matters and each stop needs its own reason to exist. Say in the pitch how the option divides across the bases they asked for.

LOVED VERSUS BEEN
These are two different lists and they pull in opposite directions. A place they LOVED tells you the appetite to match. A place they have BEEN tells you what not to offer. Somewhere can be on both lists at once — that means find the same feeling somewhere new, never send them back. Never recommend anywhere on the been list, and never recommend its immediate neighbour either: the next valley along is still the same holiday.

IF THEY NAME A COUNTRY OR REGION
Sometimes they already know roughly where and want help choosing within it. Then the three options are REGIONS OR VALLEYS INSIDE that place, never other countries. This is where you can be most useful, because the difference between two valleys is exactly what a family cannot research for themselves.

DATES AND NIGHTS
They give you a window and a number of nights, not fixed dates. Treat the window as flexible and say which part of it you would use and why — a week inside a month can differ enormously. If they have asked to skip the first week of the school holidays, honour it and do not argue.

THE WILDCARD
One option that should not work on the stated brief but might. Its job is to test whether the brief is right, not to win. It must be genuinely viable, never a straw man, and its trade-off must be honest.

THE STATS GRID
Every option carries a "stats" object with exactly those six keys, always, in that order, so the four options line up in a table. Values are three words or fewer and must be COMPARABLE — if one says "70 min" the others say "90 min" and "2h 40", never "quick" and "a fair way".

Same vocabulary across all options:
- From the airport — minutes or hours, and name the airport if it differs between options.
- Swimming, For the children — one of: none, some, good, excellent.
- Cost for the week — a rough range for the whole family in pounds, e.g. "£3,000–4,000". A range, never a point figure.
- British visitors — "very few", "some", "a lot". NEVER a percentage. You do not have that data and inventing one would be worse than saying nothing.
- Getting around — what it actually needs: "trains only", "car needed", "car for day trips".

Fill every row even where two options agree. The interface decides what to show.

VERSUS A PLACE THEY KNOW
Every option carries a "versus" block comparing it to somewhere they told you they have actually been. Two sentences, honest in both directions, and it must say what the old place wins on. "Half the cost and a quarter of the crowds of Lauterbrunnen; Lauterbrunnen wins on sheer drama and the train journey." This is the comparison families make in their heads, so make it for them. Choose the most relevant place they named, not always the same one.

PHOTOGRAPHS
Each option carries three "shots". These are search terms, not descriptions, and they must name SPECIFIC THINGS, never regions. "Salzkammergut" returns an aerial view of a region. "Grundlsee" returns a lake, "Grunberg summer toboggan" returns the thing a child would ride, "Altaussee village" returns the street they would walk to the shop.

Always exactly three shots, in this order: the water, the thing the children would actually do, and the base they would sleep in. If an option genuinely has no water, substitute the second-best thing to look at and label it honestly.

If you are not certain a named feature exists, leave that shot's q as an empty string rather than inventing a name. An empty shot is fine. A wrong one is not.

COORDINATES AND WIKIPEDIA
Give the coordinates of the base, not of the region. Give the exact English Wikipedia article title if you are confident one exists, otherwise null — this is used to check the place is real, so a wrong title is worse than none.

REGISTER
British English. N dashes, never M dashes. Warm but not breathless. No "hidden gem", no "off the beaten path", no "gateway to", no "nestled". Specific beats clever. Short sentences.

Return ONLY valid JSON, no markdown fence, in exactly this shape:

{
  "reading": "One or two sentences naming the mechanic you extracted from their brief. Say what you inferred if you inferred it.",
  "options": [
    {
      "name": "Place",
      "where": "Region, Country",
      "shape": "Three or four words for what kind of trip this is",
      "pitch": "Two sentences. What this place is and why it answers their brief.",
      "fit": ["Specific link back to something they actually said", "Another", "Another"],
      "tradeoff": "One sentence. The real cost of choosing this.",
      "risks": [
        {"risk":"Short label","answer":"How it is handled or why it is survivable."},
        {"risk":"Short label","answer":"..."}
      ],
      "say": "The sentence they would say when someone asks where they are going.",
      "check": ["Specific thing to verify with an operator before booking", "Another"],
      "stats": {
        "From the airport": "", "Swimming": "", "For the children": "",
        "Cost for the week": "", "British visitors": "", "Getting around": ""
      },
      "versus": {"place": "A place they told you they have been", "text": "Two sentences comparing this option against that place, honestly, including what the old place wins on."},
      "wikipedia": "Exact English Wikipedia article title for this place, or null if you are not certain one exists",
      "lat": 47.12, "lng": 13.45,
      "shots": [
        {"label":"The water","q":"Name of the specific lake, river or pool"},
        {"label":"What they would do","q":"Name of the specific lift, toboggan run, gorge, park or trail"},
        {"label":"The base","q":"Name of the specific village or town they would stay in"}
      ]
    }
  ],
  "wildcard": { same shape as an option },
  "ruledout": [
    {"name":"An obvious place you deliberately did not pick","why":"One clause."}
  ]
}

Exactly three options. Exactly one wildcard. Two or three ruled out — and these should be the obvious answers you rejected, which is how the family knows you looked past them.

IF THEY COME BACK WITH FEEDBACK
You will sometimes be given your previous options and a note about them. Then:
- Keep anything they liked. Do not reshuffle for the sake of it.
- Act on the note literally. "Less remote" means less remote, not a different flavour of remote.
- Anything you drop goes into ruledout with the reason, so the record of what was considered survives.
- Never return the same place with new adjectives. If it stays, it stays as it was.`;

/* ============================ handler ============================ */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });

    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: 'Bad request body' }, 400, cors); }

    const b = payload.brief || {};
    const lines = [
      b.mode === 'known' && b.where ? `THEY ALREADY KNOW ROUGHLY WHERE: ${b.where}. Give three regions or valleys inside it, not other countries.` : 'They are open to anywhere.',
      `Travelling: ${b.travellers || 'not stated'}`,
      `Window: ${b.window || 'not stated'}`,
      `Length: ${b.nights || 'not stated'}`,
      b.avoidFirstWeek ? 'They want to avoid the first week of the school holidays.' : null,
      `Flying from: ${b.airport || 'not stated'}`,
      (b.flight || []).length ? `Flight limits: ${b.flight.join(', ')}` : null,
      '',
      'WHAT THEY ENJOYED (abstract this before searching):',
      b.loved || 'not stated',
      '',
      b.bases ? `Bases: ${b.bases}` : null,
      b.loved_places ? `Places they LOVED (match the feeling, do not send them back): ${b.loved_places}` : null,
      b.been ? `Places they have BEEN (never offer these or their immediate neighbours): ${b.been}` : null,
      b.ruled ? `Also ruled out: ${b.ruled}` : null,
      b.budget ? `Money: ${b.budget}` : null,
      (b.ruin || []).length ? `Would ruin it: ${b.ruin.join(', ')}` : null
    ].filter(x => x !== null);

    if (payload.feedback && payload.previous) {
      lines.push('', 'YOU PREVIOUSLY OFFERED:',
        JSON.stringify({
          options: (payload.previous.options || []).map(o => ({ name: o.name, where: o.where })),
          wildcard: payload.previous.wildcard ? { name: payload.previous.wildcard.name } : null
        }),
        '', `THEIR NOTE ON IT: ${payload.feedback}`);
    }

    let parsed;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL, max_tokens: 5000, system: SYSTEM,
          messages: [{ role: 'user', content: lines.join('\n') }]
        })
      });
      if (!r.ok) {
        const detail = await r.text();
        return json({ error: `Upstream ${r.status}`, detail: detail.slice(0, 400) }, 502, cors);
      }
      const data = await r.json();
      const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
      const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      return json({ error: 'The planner returned something unreadable', detail: String(e).slice(0, 300) }, 502, cors);
    }

    /* pictures and the existence check, in parallel across all four options */
    const all = [...(parsed.options || []), ...(parsed.wildcard ? [parsed.wildcard] : [])];
    const spend = { n: 0 };
    await Promise.all(all.map(o => decorate(o, env, spend)));

    return json(parsed, 200, cors);
  }
};

/* ============================ pictures ============================ */

async function decorate(o, env, spend) {
  /* Wikipedia gives the lead image, the real coordinates, and doubles as the
     existence check — no article usually means the place is not real. */
  let lead = null;
  if (o.wikipedia && spend.n < BUDGET) {
    spend.n++;
    const w = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(o.wikipedia)}`);
    if (w && !w.type?.includes('not_found')) {
      o.verified = true;
      if (w.coordinates) { o.lat = w.coordinates.lat; o.lng = w.coordinates.lon; }
      if (w.originalimage?.source) lead = {
        url: w.originalimage.source, credit: 'Wikipedia', licence: 'see article',
        link: w.content_urls?.desktop?.page || null, source: 'wikipedia'
      };
    } else {
      o.verified = false;
    }
  }

  const shots = (o.shots || []).filter(s => s && s.q);
  o.images = [];
  for (const s of shots) {
    const img = await findShot(s.q, o.lat, o.lng, env, spend);
    if (img) o.images.push({ ...img, label: s.label || '' });
  }
  if (!o.images.length && lead) o.images.push({ ...lead, label: '' });
}

async function findShot(q, lat, lng, env, spend) {
  return (await commonsSearch(q, spend))
      || (await commonsNearby(lat, lng, spend))
      || (await flickrNearby(lat, lng, env, spend))
      || null;
}

/* 1 — curated Commons, searched on the specific feature name */
async function commonsSearch(q, spend) {
  if (spend.n >= BUDGET) return null;
  spend.n++;
  const u = `${COMMONS}?action=query&format=json&origin=*&generator=search`
    + `&gsrsearch=${encodeURIComponent(q + ' ' + QUALITY)}&gsrnamespace=6&gsrlimit=3`
    + `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1400`;
  return firstCommons(await getJSON(u));
}

/* 2 — Commons geosearch, then keep only the assessed ones */
async function commonsNearby(lat, lng, spend) {
  if (!lat || !lng || spend.n >= BUDGET) return null;
  spend.n++;
  const u = `${COMMONS}?action=query&format=json&origin=*&generator=geosearch`
    + `&ggscoord=${lat}|${lng}&ggsradius=10000&ggsnamespace=6&ggslimit=25`
    + `&prop=imageinfo|categories&iiprop=url|extmetadata&iiurlwidth=1400`
    + `&cllimit=max&clcategories=${encodeURIComponent('Category:Quality images|Category:Featured pictures on Wikimedia Commons|Category:Valued images')}`;
  const d = await getJSON(u);
  const pages = Object.values(d?.query?.pages || {}).filter(p => (p.categories || []).length);
  return firstCommons({ query: { pages } });
}

function firstCommons(d) {
  const pages = Object.values(d?.query?.pages || {});
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const url = ii.thumburl || ii.url;
    if (!/\.(jpe?g|png|webp)$/i.test(url.split('?')[0])) continue;   // no SVG diagrams, no maps
    const m = ii.extmetadata || {};
    return {
      url,
      credit: strip(m.Artist?.value) || 'Wikimedia Commons',
      licence: strip(m.LicenseShortName?.value) || 'see file page',
      link: ii.descriptionurl || null,
      source: 'commons'
    };
  }
  return null;
}

/* 3 — Flickr, by interestingness, commercial-safe licences only. Optional. */
async function flickrNearby(lat, lng, env, spend) {
  if (!env.FLICKR_API_KEY || !lat || !lng || spend.n >= BUDGET) return null;
  spend.n++;
  const d = 0.09;                                   // roughly 10 km
  const bbox = [lng - d, lat - d, lng + d, lat + d].join(',');
  const u = `https://api.flickr.com/services/rest?method=flickr.photos.search`
    + `&api_key=${env.FLICKR_API_KEY}&bbox=${bbox}&sort=interestingness-desc`
    + `&license=${CC_SAFE}&content_type=1&media=photos&safe_search=1`
    + `&extras=owner_name,license,url_c,url_l&per_page=5&format=json&nojsoncallback=1`;
  const r = await getJSON(u);
  const p = (r?.photos?.photo || [])[0];
  if (!p) return null;
  const LIC = { 4: 'CC BY', 5: 'CC BY-SA', 9: 'CC0', 10: 'Public Domain Mark' };
  return {
    url: p.url_l || p.url_c,
    credit: p.ownername || 'Flickr',
    licence: LIC[p.license] || 'Creative Commons',
    link: `https://www.flickr.com/photos/${p.owner}/${p.id}`,
    source: 'flickr'
  };
}

/* ============================ plumbing ============================ */

const strip = h => h ? String(h).replace(/<[^>]*>/g, '').trim().slice(0, 80) : '';

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'family-trip-planner/0.1 (prototype)' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...cors }
  });
}
