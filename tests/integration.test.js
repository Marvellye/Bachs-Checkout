/**
 * Integration tests against the Bachs SANDBOX. Real HTTP, real charges, no real money.
 *
 * They are skipped unless credentials are present:
 *
 *   BACHS_SECRET_KEY=sk_sandbox_... PRODUCT_ID=prod_... npm run test:integration
 *
 * PRODUCT_ID is optional - the raw-amount path creates a product-less session, which is the case
 * most likely to break, so that is what runs by default.
 *
 * NEVER point these at a live key. They create sessions and move sandbox money.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Bachs, CheckoutSession } from "../src/index.js";

const SECRET = process.env.BACHS_SECRET_KEY;
const hasKey = Boolean(SECRET);
const skip = hasKey ? false : "set BACHS_SECRET_KEY to run integration tests";

if (hasKey && SECRET.startsWith("sk_live_")) {
  throw new Error("refusing to run integration tests with a live key");
}

const bachs = hasKey ? new Bachs({ secretKey: SECRET }) : null;
const common = {
  customer: { email: "integration@example.com", name: "Integration Test" },
  success_url: "https://example.com/paid",
  cancel_url: "https://example.com/cancelled",
};

test("card payment settles end to end", { skip }, async () => {
  const session = await bachs.checkoutSessions.createRaw({
    ...common,
    amount: "1.00",
    currency: "USD",
    reference: `it-card-${Date.now()}`,
    metadata: { source: "integration-test" },
  });

  assert.equal(session.amount, "1.00");
  assert.match(session.checkout_url, /\/c\//);

  const checkout = CheckoutSession.fromUrl(session.checkout_url);
  const detail = await checkout.detail();
  assert.equal(detail.amount, "1.00");
  assert.equal(detail.products, null, "product-less sessions report products: null, not []");
  assert.ok(detail.payment_methods.length > 0);

  const payment = await checkout.pay({
    rail: "card",
    currency: "USD",
    card: { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" },
  });
  assert.equal(payment.type, "card");
  assert.match(payment.chargeId, /^ch_/);

  const final = await checkout.waitForPayment(payment.chargeId, { timeoutMs: 60000, intervalMs: 2000 });
  assert.equal(final.charge_status, "succeeded");
  assert.equal(final.amount_paid, "1.00");
  assert.equal(final.amount_remaining, "0.00");

  const server = await bachs.checkoutSessions.get(session.checkout_id);
  assert.equal(server.status, "completed");
});

test("a declined card leaves the session open for retry", { skip }, async () => {
  const session = await bachs.checkoutSessions.createRaw({
    ...common,
    amount: "1.00",
    currency: "USD",
    reference: `it-decline-${Date.now()}`,
  });
  const checkout = CheckoutSession.fromUrl(session.checkout_url);

  const payment = await checkout.pay({
    rail: "card",
    currency: "USD",
    card: { card_number: "4000000000000002", expiry_month: 9, expiry_year: 2033, cvv: "431" },
  });

  const final = await checkout.waitForPayment(payment.chargeId, { timeoutMs: 60000, intervalMs: 2000 });
  assert.equal(final.attempt_failed, true);
  assert.equal(final.failure_code, "bank_declined");
  assert.equal(final.checkout_status, "open", "a decline is retryable on the same session");

  const server = await bachs.checkoutSessions.get(session.checkout_id);
  assert.equal(server.status, "open");
});

test("bank transfer returns account details to render", { skip }, async () => {
  const session = await bachs.checkoutSessions.createRaw({
    ...common,
    amount: "1.00",
    currency: "USD",
    reference: `it-bank-${Date.now()}`,
  });
  const checkout = CheckoutSession.fromUrl(session.checkout_url);

  const payment = await checkout.pay({ rail: "bank" });
  assert.equal(payment.type, "bank_transfer");
  assert.match(payment.instructions.accountNumber, /^\d{6,}$/);
  assert.ok(payment.instructions.bankName, "bank name is needed for the UI");
  assert.equal(payment.currency, "NGN", "NGN bank transfer converts from the USD base amount");
  assert.equal(payment.pollingRequired, true);
});

test("crypto returns an address and a countdown", { skip }, async () => {
  const session = await bachs.checkoutSessions.createRaw({
    ...common,
    amount: "1.00",
    currency: "USD",
    reference: `it-crypto-${Date.now()}`,
  });
  const checkout = CheckoutSession.fromUrl(session.checkout_url);

  const payment = await checkout.pay({ rail: "crypto", currency: "USDT_TRC20" });
  assert.equal(payment.type, "crypto");
  assert.ok(payment.instructions.address);
  assert.ok(payment.instructions.network);
  assert.ok(payment.instructions.expiresInMinutes > 0);
});

test("mobile money asks for network then phone, and returns an approval prompt", { skip }, async () => {
  const session = await bachs.checkoutSessions.createRaw({
    ...common,
    amount: "1.00",
    currency: "USD",
    reference: `it-momo-${Date.now()}`,
  });
  const checkout = CheckoutSession.fromUrl(session.checkout_url);

  const req = await checkout.requirements({ paymentMethod: "MOMO_GHS", currency: "GHS" });
  const railField = req.fields.find((f) => f.id === "payment_rail");
  assert.ok(railField, "mobile money must expose the network selector");
  const network = railField.options[0].value;

  const payment = await checkout.pay({ rail: "momo_ghs", phone: "+233201234567", paymentRail: network });
  assert.equal(payment.type, "mobile_money");
  assert.equal(payment.instructions.action, "approve_on_phone");
});

test("free sessions complete without a payment instrument", { skip }, async () => {
  const session = await bachs.checkoutSessions.createFree({ ...common, currency: "USD", reference: `it-free-${Date.now()}` });
  const checkout = CheckoutSession.fromUrl(session.checkout_url);

  const detail = await checkout.detail();
  assert.equal(detail.amount, "0.00");
  assert.equal(detail.payment_required, false);

  const payment = await checkout.pay({ rail: "free" });
  assert.equal(payment.type, "redirect");
  assert.ok(payment.url, "a free checkout still redirects to success_url");

  const server = await bachs.checkoutSessions.get(session.checkout_id);
  assert.equal(server.status, "completed");
});

test("custom pricing accepts a browser-chosen amount", { skip }, async () => {
  const session = await bachs.checkoutSessions.createCustom({
    ...common,
    currency: "USD",
    presetAmount: "5.00",
    minimumAmount: "1.00",
    maximumAmount: "50.00",
    reference: `it-custom-${Date.now()}`,
  });
  assert.equal(session.amount, "5.00", "the preset is the opening amount");

  const checkout = CheckoutSession.fromUrl(session.checkout_url);
  await checkout.setAmount("7.50");
  const detail = await checkout.detail();
  assert.equal(detail.amount, "7.50");
  assert.equal(detail.price_type, "custom");
});
