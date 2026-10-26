// Discover the card-vault server-action ids on whatever checkout build is live.
//
// The ids in sdk/index.mjs come from the sandbox bundle. Production is a different build with
// different ids, so any live use must resolve them at runtime instead of trusting the constants.
//
//   node tools/discover-actions.mjs https://sandbox-checkout.bachs.io <checkout-token>

const NAMES = [
  "mintTokenizeGrant",
  "tokenizeCardWithGrantRetry",
  "completeCardCheckout",
  "authorizeCardStep",
  "authorizePinViaVault",
  "pollChargeStatus",
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BachsSDKProbe";
const MAX_CHUNKS = 250;
const CONCURRENCY = 8;

// Both plain ("<id>") and escaped (\"<id>\") forms appear, depending on how the module is bundled.
// Action ids are hex of varying length (42 in this build), so don't pin an exact width.
const ACTION_RE = /createServerReference\)\(\s*\\?"([0-9a-f]{20,64})\\?"[^;]{0,200}?\\?"([A-Za-z_][A-Za-z0-9_]{3,60})\\?"\s*\)/g;
// Matches both the page's "/_next/static/chunks/x.js" and a chunk's own "static/chunks/x.js" refs.
const CHUNK_RE = /static\/chunks\/([A-Za-z0-9~._-]+\.js)/g;

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function chunkNamesIn(body) {
  const out = new Set();
  for (const m of body.matchAll(CHUNK_RE)) out.add(m[1]);
  return out;
}

/**
 * Breadth-first crawl of the checkout bundle, stopping once every action is found.
 * @returns {Promise<{actions: Record<string,{id:string,chunk:string}>, crawled:number, missing:string[]}>}
 */
export async function discoverActions(origin, token, { maxChunks = MAX_CHUNKS } = {}) {
  if (!token) throw new Error("a checkout token is required to read the checkout build");
  const base = origin.replace(/\/+$/, "");

  const page = await get(`${base}/c/${token}`);
  if (page === null) throw new Error(`checkout page not reachable at ${base}/c/${token}`);

  const actions = {};
  const seen = new Set();
  const queue = [...chunkNamesIn(page)];
  let crawled = 0;

  while (queue.length && crawled < maxChunks && Object.keys(actions).length < NAMES.length) {
    const batch = queue.splice(0, CONCURRENCY).filter((n) => !seen.has(n));
    batch.forEach((n) => seen.add(n));
    if (!batch.length) continue;

    const bodies = await Promise.all(batch.map(async (name) => {
      crawled += 1;
      return { name, body: await get(`${base}/_next/static/chunks/${name}`) };
    }));

    for (const { name, body } of bodies) {
      if (!body) continue;
      for (const m of body.matchAll(ACTION_RE)) {
        const [, id, actionName] = m;
        if (NAMES.includes(actionName) && !actions[actionName]) actions[actionName] = { id, chunk: name };
      }
      for (const ref of chunkNamesIn(body)) if (!seen.has(ref)) queue.push(ref);
    }
  }

  const missing = NAMES.filter((n) => !actions[n]);
  return { actions, crawled, missing };
}

if (process.argv[1] && process.argv[1].endsWith("discover-actions.mjs")) {
  const [origin = "https://sandbox-checkout.bachs.io", token] = process.argv.slice(2);
  if (!token) {
    console.error("usage: node tools/discover-actions.mjs <checkout-origin> <checkout-token>");
    process.exit(1);
  }
  const { actions, crawled, missing } = await discoverActions(origin, token);
  console.log(JSON.stringify(actions, null, 2));
  console.error(`crawled ${crawled} chunks on ${origin}`);
  if (missing.length) {
    console.error("missing:", missing.join(", "));
    process.exit(2);
  }
}
