// CLI wrapper around src/discover.js. The crawler itself ships in the package, because every
// live card charge needs it: sandbox and live builds carry different action ids.
//
//   node scripts/discover-actions.mjs https://checkout.bachs.io <checkout-token>
import { discoverCardActions } from "../src/discover.js";

const [origin = "https://sandbox-checkout.bachs.io", token] = process.argv.slice(2);
if (!token) {
  console.error("usage: node scripts/discover-actions.mjs <checkout-origin> <checkout-token>");
  process.exit(1);
}

const { ids, chunks, crawled, missing } = await discoverCardActions(origin, token);
console.log(JSON.stringify(ids, null, 2));
console.error(`crawled ${crawled} chunks on ${origin}`);
for (const name of Object.keys(ids)) console.error(`  ${name} <- ${chunks[name]}`);
if (missing.length) {
  console.error("missing:", missing.join(", "));
  process.exit(2);
}
