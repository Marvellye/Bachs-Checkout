#!/usr/bin/env node
/**
 * Fingerprint the hosted checkout, so a redeploy shows up as a diff instead of a mystery failure.
 *
 *   node scripts/fingerprint.mjs                  # print the fingerprint as JSON
 *   node scripts/fingerprint.mjs --compare FILE   # exit 2 when the build moved, 0 when it did not
 *
 * What it watches, in order of how loudly it breaks things:
 *   1. the transport - REST (/api/checkouts) or the old Next.js server actions
 *   2. the asset bundle hashes on the checkout page
 *   3. whether the REST card endpoints still answer
 */
import fs from "node:fs";
import { Bachs, CheckoutSession } from "../src/index.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith("--")) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args[key] = next;
    i += 1;
  } else {
    args[key] = true;
  }
}

const SECRET = process.env.BACHS_SECRET_KEY;
if (!SECRET) {
  console.error("BACHS_SECRET_KEY is required (sandbox key only)");
  process.exit(1);
}
if (SECRET.startsWith("sk_live_")) {
  console.error("refusing to fingerprint with a live key: this script creates a session");
  process.exit(1);
}

const bachs = new Bachs({ secretKey: SECRET });
const session = await bachs.checkoutSessions.createRaw({
  amount: "100",
  currency: "NGN",
  customer: { email: "drift-probe@example.com" },
  success_url: "https://example.com/paid",
  cancel_url: "https://example.com/cancelled",
});

const token = String(session.checkout_url).split("/").pop();
const checkout = CheckoutSession.fromUrl(session.checkout_url);
const page = await fetch(`${checkout.checkoutOrigin}/c/${token}`, {
  headers: { "User-Agent": "bachs-checkout-fingerprint/1" },
}).then((r) => r.text());

const assets = [...new Set([...page.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))].sort();
const nextChunks = [...new Set([...page.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9~._-]+\.js)/g)].map((m) => m[1]))];
const transport = assets.length ? "rest" : nextChunks.length ? "legacy" : "unknown";

// Do the endpoints the SDK depends on still exist, and do they still answer?
const probe = async (path, body) => {
  const res = await fetch(`${checkout.checkoutOrigin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { status: 0 };
  const text = await res.text().catch(() => "");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, keys: parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [] };
};

const detail = await probe(`/api/checkouts/${token}`);
const grant = await probe(`/api/checkouts/${token}/tokenize-grant`, {});
const vaultKey = await probe("/api/vault/public-key");
const legacyDetail = await fetch(`${bachs.baseUrl}/v1/public/checkouts/${token}/detail`, {
  headers: { Accept: "application/json" },
})
  .then((r) => ({ status: r.status }))
  .catch(() => ({ status: 0 }));

const fingerprint = {
  checkedAt: new Date().toISOString(),
  checkoutOrigin: checkout.checkoutOrigin,
  transport,
  assetCount: assets.length,
  assets,
  nextChunkCount: nextChunks.length,
  endpoints: {
    "GET /api/checkouts/{token}": detail.status,
    "POST /api/checkouts/{token}/tokenize-grant": grant.status,
    "GET /api/vault/public-key": vaultKey.status,
  },
  fields: {
    detail: detail.keys,
    tokenizeGrant: grant.keys,
    vaultKey: vaultKey.keys,
  },
  legacyV1Detail: legacyDetail.status,
};

if (!args.compare) {
  console.log(JSON.stringify(fingerprint, null, 2));
  process.exit(0);
}

const previous = JSON.parse(fs.readFileSync(String(args.compare), "utf8"));
const changes = [];

if (previous.transport !== fingerprint.transport) {
  changes.push(`transport moved: ${previous.transport} -> ${fingerprint.transport}`);
}
if (JSON.stringify(previous.assets) !== JSON.stringify(fingerprint.assets)) {
  const added = fingerprint.assets.filter((a) => !previous.assets?.includes(a));
  const removed = (previous.assets || []).filter((a) => !fingerprint.assets.includes(a));
  changes.push(`assets changed: +${added.length} -${removed.length}${added.length ? ` (new: ${added[0]})` : ""}`);
}
for (const [name, status] of Object.entries(fingerprint.endpoints)) {
  const was = previous.endpoints?.[name];
  if (was !== status) changes.push(`${name}: ${was} -> ${status}`);
}
for (const [name, keys] of Object.entries(fingerprint.fields)) {
  const before = previous.fields?.[name] || [];
  const added = keys.filter((k) => !before.includes(k));
  const removed = before.filter((k) => !keys.includes(k));
  if (added.length) changes.push(`${name} gained fields: ${added.join(", ")}`);
  if (removed.length) changes.push(`${name} lost fields: ${removed.join(", ")}`);
}

if (!changes.length) {
  console.log("no drift");
  process.exit(0);
}

console.log("the checkout build moved:");
for (const change of changes) console.log(`  - ${change}`);
console.log(`\nnew fingerprint:\n${JSON.stringify(fingerprint, null, 2)}`);
process.exit(2);
