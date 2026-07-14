// THE CAUSE TAXONOMY — one copy, shared by the collector and the digest.
//
// THE BUG THIS EXISTS TO KILL:
//
// The old regex was  /(weather|flood|ice|snow|...)/i  — no word boundaries.
// So "ice" matched inside "serv-ICE".
//
// And EVERY TfL disruption message contains the word "service":
//   "No SERVICE between Hackney Downs and Chingford…"
//   "…GOOD SERVICE on the rest of the line."
//   "…will operate at a reduced SERVICE…"
//
// So virtually EVERY incident was classified as WEATHER. A fallen tree: weather.
// A lineside fire: weather. Train cancellations: weather. It had been silently
// poisoning the data since the first day of collection.
//
// The lesson is not "add word boundaries". It's that a classifier you cannot AUDIT
// is a classifier you cannot trust — which is why the dashboard now quotes TfL's
// own words under every incident. The bug was invisible for days, and became
// obvious within seconds of showing the source text.

export type Cause =
  | 'signal-failure' | 'train-fault' | 'person-on-track' | 'trespass'
  | 'fatality' | 'customer-incident' | 'staff-shortage' | 'weather'
  | 'fire-alert' | 'security-alert' | 'power-failure' | 'obstruction'
  | 'congestion' | 'engineering' | 'earlier-incident' | 'other' | 'none';

// Order matters — first match wins, so the specific goes before the general.
const RULES: [Cause, RegExp][] = [
  // People. Most specific first: a fatality is not "a person on the track".
  ['fatality', /\b(person|casualty) (has been )?(hit|struck)\b|\bfatality\b|\bperson under a train\b/i],
  ['person-on-track', /\bperson(s)? on the (track|line)\b|\bpeople on the (track|line)\b/i],
  ['trespass', /\btrespass|\bintruder/i],
  ['customer-incident', /\bcustomer (taken )?ill\b|\bpassenger (taken )?ill\b|\bill (customer|passenger)\b|\bpassenger action\b|\bcustomer incident\b/i],

  // Infrastructure.
  ['signal-failure', /\bsignal(ling)? (failure|problem|fault)\b|\bpoints failure\b|\btrack circuit\b|\bsignal at\b/i],
  ['power-failure', /\bpower (failure|supply|fault)\b|\bloss of power\b|\belectrical (fault|failure)\b/i],
  ['train-fault', /\btrain fault\b|\bfaulty train\b|\bdefective train\b|\btrain cancellations?\b|\bbroken[- ]down train\b|\bshortage of trains\b/i],

  // Physical obstruction — a fallen tree is NOT "weather", even if a storm put it
  // there. The recovery profile is completely different: weather clears when the
  // weather clears; a tree clears when someone with a chainsaw arrives.
  ['obstruction', /\b(tree|debris|object|obstruction|vehicle)\b.{0,30}\b(on|from|across)\b.{0,20}\b(track|line)\b|\bremove a tree\b|\bfallen tree\b/i],

  ['fire-alert', /\bfire (alert|alarm)\b|\blineside fire\b|\bline side fire\b|\bsmoke\b/i],
  ['security-alert', /\bsecurity alert\b|\bsuspicious (item|package|vehicle)\b|\bpolice (request|incident|dealing)\b|\bemergency services\b/i],

  // Weather — WITH WORD BOUNDARIES. \b stops "ice" matching "service".
  ['weather', /\b(bad |adverse |severe )?weather\b|\bflood(ing|ed)?\b|\bicy?\b|\bsnow\b|\blightning\b|\bheatwave\b|\bhigh winds?\b|\bstorm\b|\bfog\b|\bleaves on the (track|line)\b|\bleaf fall\b/i],

  ['staff-shortage', /\bshortage of (train )?(operators|drivers|staff)\b|\bstaff (shortage|availability)\b|\bindustrial action\b|\bstrike\b/i],
  ['engineering', /\bengineering work\b|\bplanned (closure|work)\b|\btrack (work|maintenance)\b|\bupgrade work\b|\bundertake repairs\b|\brepairs\b/i],
  ['earlier-incident', /\bearlier (incident|delays|problem|fault)\b|\bfollowing (an? )?earlier\b/i],
  ['congestion', /\bcongestion\b|\bknock[- ]on\b|\bservice recovery\b|\bregulating the service\b/i],
];

export function classify(reason?: string): Cause {
  if (!reason || !reason.trim()) return 'none';
  for (const [tag, re] of RULES) if (re.test(reason)) return tag;
  return 'other';
}

// PLANNED vs UNPLANNED — and why the Elizabeth line's 797 minutes was misleading.
//
// TfL announced, in advance, that on Sunday 12 July the Elizabeth line would run
// at reduced frequency ALL DAY while they repaired the Stratford fire damage.
//
// The 797 minutes is CORRECT — it really was disrupted all day. But lumping a
// pre-announced, all-day reduced service in with a 30-minute signal failure and
// taking a median of the two is comparing unlike things. One is a surprise you
// must react to; the other is a fact you could have planned around.
//
// The app only cares about the first kind. So we tag them, and keep planned
// disruption out of the recovery medians while still showing it.
const PLANNED = [
  /\ball day (on|from)\b/i,
  /\bplanned\b/i,
  /\bwhile we (undertake|carry out|complete)\b/i,
  /\bengineering work\b/i,
  /\bimprovement work\b/i,
  /\buntil further notice\b/i,
  /\bevery (sunday|saturday|weekend)\b/i,
  /\breduced (frequency|service).{0,40}\bwhile we\b/i,
];

export function isPlanned(reason?: string): boolean {
  if (!reason) return false;
  return PLANNED.some((re) => re.test(reason));
}
