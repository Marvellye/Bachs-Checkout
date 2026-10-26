// Local check for examples/server.mjs: does the browser→server card path work end to end?
// Stands in for the browser: seals with the vault key exactly as src/browser.js does, then posts
// only ciphertext. Run while the example server is listening.
import { CardVault } from "../src/index.js";

const BASE = process.env.EXAMPLE_URL || "http://localhost:4243";
const ORIGIN = "https://sandbox-checkout.bachs.io";

const session = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount: "1.00", currency: "USD" }),
}).then((r) => r.json());
console.log("session:", session);

const pem = await fetch(`${ORIGIN}/api/vault/public-key`).then((r) => r.json()).then((j) => j.public_key_pem);
const sealed = CardVault.seal(pem, {
  card_number: "4242424242424242",
  expiry_month: 9,
  expiry_year: 2033,
  cvv: "431",
});
console.log("sealed bytes:", sealed.ciphertext.length, "b64 chars (no PAN in the payload)");
if (sealed.ciphertext.includes("4242")) throw new Error("PAN leaked into the sealed payload");

const result = await fetch(`${BASE}/api/pay/card`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: session.token, sealed, device: { javascript_enabled: true } }),
}).then((r) => r.json());
console.log("payment:", JSON.stringify(result).slice(0, 300));

if (!result.chargeId) throw new Error("no charge created");

for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const status = await fetch(`${BASE}/api/status/${session.token}/${result.chargeId}`).then((r) => r.json());
  console.log("status:", status.charge_status, status.substatus ?? "", status.attempt_status ?? "");
  if (["succeeded", "paid"].includes(status.charge_status)) {
    console.log("PAID", status.amount_paid);
    process.exit(0);
  }
  if (status.attempt_failed) {
    console.error("declined:", status.failure_code, status.failure_message);
    process.exit(3);
  }
}
console.error("timed out waiting for a terminal state");
process.exit(2);
