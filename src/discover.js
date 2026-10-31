/**
 * The card vault's server-action ids are per checkout build. Sandbox and live carry different
 * values, and every deploy can rotate them, so they have to be resolved at runtime instead of
 * being trusted as constants. A retired id answers 404 and surfaces as ACTION_STALE.
 *
 * This module finds them by crawling the public checkout bundle for `createServerReference` calls.
 */
const UA = "bachs-checkout/0.2.3 (+https://github.com/Marvellye/Bachs-Checkout)";

export const CARD_ACTION_NAMES = [
  "mintTokenizeGrant",
  "tokenizeCardWithGrantRetry",
  "completeCardCheckout",
  "authorizeCardStep",
  "authorizePinViaVault",
  "pollChargeStatus",
];

const MAX_CHUNKS = 250;
const CONCURRENCY = 8;

// Both plain ("<id>") and escaped (\"<id>\") forms appear, depending on how the module is bundled.
// Ids are hex of varying length (42 in the current build), so don't pin an exact width.
const ACTION_RE =
  /createServerReference\)?\(\s*\\?"([0-9a-f]{20,64})\\?"[^;]{0,200}?\\?"([A-Za-z_][A-Za-z0-9_]{3,60})\\?"\s*\)/g;
// Matches both the page's "/_next/static/chunks/x.js" and a chunk's own "static/chunks/x.js".
const CHUNK_RE = /static\/chunks\/([A-Za-z0-9~._-]+\.js)/g;

/** Action ids declared in one JS chunk. Pure, so it can be tested without the network. */
export function parseActionIds(body) {
  const found = {};
  for (const match of String(body).matchAll(ACTION_RE)) {
    const [, id, name] = match;
    if (CARD_ACTION_NAMES.includes(name) && !found[name]) found[name] = id;
  }
  return found;
}

/** Chunk filenames referenced by a page or another chunk. Pure. */
export function parseChunkRefs(body) {
  return [...new Set([...String(body).matchAll(CHUNK_RE)].map((m) => m[1]))];
}

async function getText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Breadth-first crawl of a checkout build until every action is found or the budget runs out.
 *
 * @param {string} checkoutOrigin e.g. https://checkout.bachs.io
 * @param {string} token a live checkout token, used only to reach the page and its chunks
 * @param {{maxChunks?: number, concurrency?: number}} [opts]
 * @returns {Promise<{ids: Record<string,string>, chunks: Record<string,string>, crawled: number, missing: string[]}>}
 */
export async function discoverCardActions(checkoutOrigin, token, { maxChunks = MAX_CHUNKS, concurrency = CONCURRENCY } = {}) {
  if (!token) throw new Error("a checkout token is required to read the checkout build");
  const base = String(checkoutOrigin).replace(/\/+$/, "");

  const page = await getText(`${base}/c/${encodeURIComponent(token)}`);
  if (page === null) throw new Error(`checkout page not reachable at ${base}/c/${token}`);

  const ids = {};
  const chunks = {};
  const seen = new Set();
  const queue = parseChunkRefs(page);
  let crawled = 0;

  while (queue.length && crawled < maxChunks && Object.keys(ids).length < CARD_ACTION_NAMES.length) {
    const batch = queue.splice(0, concurrency).filter((name) => !seen.has(name));
    batch.forEach((name) => seen.add(name));
    if (!batch.length) continue;

    const bodies = await Promise.all(
      batch.map(async (name) => {
        crawled += 1;
        return { name, body: await getText(`${base}/_next/static/chunks/${name}`) };
      })
    );

    for (const { name, body } of bodies) {
      if (!body) continue;
      for (const [actionName, id] of Object.entries(parseActionIds(body))) {
        if (!ids[actionName]) {
          ids[actionName] = id;
          chunks[actionName] = name;
        }
      }
      for (const ref of parseChunkRefs(body)) if (!seen.has(ref)) queue.push(ref);
    }
  }

  const missing = CARD_ACTION_NAMES.filter((name) => !ids[name]);
  return { ids, chunks, crawled, missing };
}
