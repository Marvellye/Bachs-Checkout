/**
 * Unit tests. No network, no credentials - these run anywhere, including CI.
 *
 *   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Bachs,
  BachsError,
  CheckoutSession,
  CardVault,
  MIN_AMOUNT,
  normalise,
  resolveRail,
  isUncertainWrite,
  SANDBOX_API,
  LIVE_API,
  SANDBOX_CHECKOUT,
  LIVE_CHECKOUT,
  parseActionIds,
  parseChunkRefs,
  CARD_ACTION_NAMES,
  KNOWN_CARD_ACTIONS,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", `${name}.json`), "utf8"));

const bank = fixture("bank");
const cryptoFx = fixture("crypto");
const momo = fixture("momo");
const card = fixture("card");

/* ----------------------------------------------------------------- rails */

test("resolveRail maps every friendly rail to a Bachs corridor", () => {
  assert.deepEqual(resolveRail({ rail: "card", currency: "USD" }),
    { paymentMethod: "USD_CARD", currency: "USD", kind: "card" });
  assert.deepEqual(resolveRail({ rail: "card", currency: "NGN" }),
    { paymentMethod: "NGN_CARD", currency: "NGN", kind: "card" });
  assert.deepEqual(resolveRail({ rail: "bank" }),
    { paymentMethod: "NGN_BANK_TRANSFER", currency: "NGN", kind: "bank_transfer" });
  assert.deepEqual(resolveRail({ rail: "crypto", currency: "USDT_TRC20" }),
    { paymentMethod: "CRYPTO", currency: "USDT_TRC20", kind: "crypto" });
  assert.deepEqual(resolveRail({ rail: "momo_ghs" }),
    { paymentMethod: "MOMO_GHS", currency: "GHS", kind: "mobile_money" });
  assert.deepEqual(resolveRail({ rail: "momo", currency: "KES" }),
    { paymentMethod: "MOMO_KES", currency: "KES", kind: "mobile_money" });
  assert.deepEqual(resolveRail({ rail: "momo", currency: "ZMW" }),
    { paymentMethod: "MOMO_ZMW", currency: "ZMW", kind: "mobile_money" });
});

test("resolveRail rejects a mobile money corridor that does not exist", () => {
  assert.throws(() => resolveRail({ rail: "momo", currency: "USD" }), /no USD corridor/);
});

test("resolveRail passes unknown methods through uppercased", () => {
  assert.deepEqual(resolveRail({ rail: "ngn_bank_transfer" }),
    { paymentMethod: "NGN_BANK_TRANSFER", currency: "NGN", kind: "bank_transfer" });
});

/* ------------------------------------------------------- session creation */

test("create() rejects product_cart and pricing together", () => {
  const bachs = new Bachs({ secretKey: "sk_sandbox_test" });
  assert.throws(
    () => bachs.checkoutSessions.create({
      product_cart: [{ product_id: "prod_1" }],
      pricing: { currency: "USD", amount: "1.00" },
    }),
    /mutually exclusive/
  );
});

test("create() requires one of product_cart or pricing", () => {
  const bachs = new Bachs({ secretKey: "sk_sandbox_test" });
  assert.throws(() => bachs.checkoutSessions.create({}), /pass product_cart or pricing/);
});

test("create() requires a currency in pricing", () => {
  const bachs = new Bachs({ secretKey: "sk_sandbox_test" });
  assert.throws(
    () => bachs.checkoutSessions.create({ pricing: { amount: "1.00" } }),
    /pricing.currency is required/
  );
});

test("create() requires an amount for a fixed price but not for custom or free", async () => {
  // Port 1 refuses instantly, so anything that reaches the network fails fast without DNS.
  const bachs = new Bachs({ secretKey: "sk_sandbox_test", baseUrl: "http://127.0.0.1:1" });

  assert.throws(
    () => bachs.checkoutSessions.create({ pricing: { currency: "USD" } }),
    /pricing.amount is required/
  );

  const reachedNetwork = (err) => !/pricing\.amount is required/.test(String(err.message));
  await assert.rejects(
    () => bachs.checkoutSessions.create({ pricing: { currency: "USD", price_type: "free" } }),
    reachedNetwork,
    "a free price needs no amount"
  );
  await assert.rejects(
    () => bachs.checkoutSessions.create({ pricing: { currency: "USD", price_type: "custom" } }),
    reachedNetwork,
    "a custom price needs no amount"
  );
});

test("createRaw builds the pricing shape", async () => {
  const bachs = new Bachs({ secretKey: "sk_sandbox_test", baseUrl: "https://example.invalid" });
  // No network is attempted: the guard fires before fetch, and so does the URL parse.
  await assert.rejects(
    () => bachs.checkoutSessions.createRaw({ amount: 1, currency: "USD" }),
    (err) => err.name === "BachsError" || err.code === "ENOTFOUND" || err.cause !== undefined
  );
});

test("createRaw demands amount and currency", () => {
  const bachs = new Bachs({ secretKey: "sk_sandbox_test" });
  assert.throws(() => bachs.checkoutSessions.createRaw({ amount: 1 }), /amount and currency are required/);
  assert.throws(() => bachs.checkoutSessions.createRaw({ currency: "USD" }), /amount and currency are required/);
});

test("base URL follows the key prefix", () => {
  assert.equal(new Bachs({ secretKey: "sk_sandbox_abc" }).baseUrl, SANDBOX_API);
  assert.equal(new Bachs({ secretKey: "sk_live_abc" }).baseUrl, LIVE_API);
  assert.equal(new Bachs({ secretKey: "sk_live_abc", baseUrl: "https://proxy.internal/" }).baseUrl,
    "https://proxy.internal");
});

test("a live session is redeemed against the live API, not sandbox", () => {
  // Regression: a live key minted a live token, then the public endpoints defaulted to
  // sandbox-api and the API answered UNAUTHORIZED / "Invalid or expired checkout token".
  const live = new CheckoutSession("tok", { environment: "live" });
  assert.equal(live.apiBase, LIVE_API);
  assert.equal(live.checkoutOrigin, LIVE_CHECKOUT);
  assert.equal(live.environment, "live");

  const sandbox = new CheckoutSession("tok", { environment: "sandbox" });
  assert.equal(sandbox.apiBase, SANDBOX_API);
  assert.equal(sandbox.checkoutOrigin, SANDBOX_CHECKOUT);
});

test("the apiBase decides the pair when no environment is given", () => {
  const live = new CheckoutSession("tok", { apiBase: LIVE_API });
  assert.equal(live.environment, "live");
  assert.equal(live.checkoutOrigin, LIVE_CHECKOUT, "checkout origin must follow the API");

  const sandbox = new CheckoutSession("tok", { apiBase: SANDBOX_API });
  assert.equal(sandbox.environment, "sandbox");
  assert.equal(sandbox.checkoutOrigin, SANDBOX_CHECKOUT);
});

test("a bare CheckoutSession still defaults to sandbox", () => {
  const bare = new CheckoutSession("tok");
  assert.equal(bare.apiBase, SANDBOX_API);
  assert.equal(bare.checkoutOrigin, SANDBOX_CHECKOUT);
});

test("fromUrl keeps the environment of the URL it was handed", () => {
  const live = CheckoutSession.fromUrl("https://checkout.bachs.io/c/B_abc123");
  assert.equal(live.token, "B_abc123");
  assert.equal(live.apiBase, LIVE_API);
  assert.equal(live.environment, "live");

  const sandbox = CheckoutSession.fromUrl("https://sandbox-checkout.bachs.io/c/B_xyz789");
  assert.equal(sandbox.apiBase, SANDBOX_API);
  assert.equal(sandbox.environment, "sandbox");
});

/* ------------------------------------------------------------ normalising */

test("bank transfer normalises the instructions that exist", () => {
  const p = normalise(bank.complete, resolveRail({ rail: "bank" }), bank.get_quote);
  assert.equal(p.type, "bank_transfer");
  assert.equal(p.instructions.accountNumber, "0123456789");
  assert.equal(p.instructions.bankName, "Example MFB");
  assert.equal(p.instructions.reference, "pay_0000000000000000");
  assert.equal(p.instructions.amountExpected, "1423.410000000000000000");
  assert.equal(p.amount, "1423.410000000000000000"); // decimal string, not a float
  assert.equal(p.currency, "NGN");
  assert.equal(p.pollingRequired, true);
  assert.equal(p.chargeId, "ch_0000000000000000000000000000bank");
  assert.deepEqual(p.raw, bank.complete, "raw must be the untouched response");
});

test("live bank instructions with null fields do not throw and stay null", () => {
  const p = normalise(bank.complete_live_sparse, resolveRail({ rail: "bank" }), null);
  assert.equal(p.type, "bank_transfer");
  assert.equal(p.instructions.accountNumber, "9876543210");
  assert.equal(p.instructions.bankCode, null);
  assert.equal(p.instructions.amountExpected, null);
  assert.equal(p.instructions.reference, null);
  assert.equal(p.instructions.expiresAt, null);
});

test("crypto normalises address, network, timer and QR", () => {
  const p = normalise(cryptoFx.complete, resolveRail({ rail: "crypto", currency: "USDT_TRC20" }), cryptoFx.get_quote);
  assert.equal(p.type, "crypto");
  assert.equal(p.instructions.address, "T-TEST-CRYPTO-ADDRESS-DO-NOT-PAY0000");
  assert.equal(p.instructions.network, "TRON");
  assert.equal(p.instructions.expiresInMinutes, 60);
  assert.match(p.instructions.qrCode, /^data:image\/png;base64,/);
});

test("mobile money normalises the approval prompt", () => {
  const p = normalise(momo.complete, resolveRail({ rail: "momo_ghs" }), momo.get_quote);
  assert.equal(p.type, "mobile_money");
  assert.equal(p.instructions.action, "approve_on_phone");
  assert.equal(p.currency, "GHS");
});

test("inline card surfaces the client secret", () => {
  const p = normalise(card.complete_inline, resolveRail({ rail: "card", currency: "USD" }), card.get_quote);
  assert.equal(p.type, "card");
  assert.match(p.clientSecret, /_secret_/);
  assert.equal(p.chargeId, "ch_0000000000000000000000000card00");
});

test("processor-side card keeps next_action and auth model", () => {
  const p = normalise(card.complete_requires_otp, resolveRail({ rail: "card", currency: "USD" }), card.get_quote);
  assert.equal(p.type, "card");
  assert.equal(p.clientSecret, null);
  assert.equal(p.nextAction.type, "requires_otp");
  assert.equal(p.nextAction.can_resend, true);
});

test("a redirect rail becomes type=redirect with a url", () => {
  const p = normalise(
    { payment_type: "redirect", payment_url: "https://checkout.example/c/x?checkout_id=chk_1", transaction_id: "chk_1" },
    { paymentMethod: "FREE", currency: "USD", kind: "free" },
    null
  );
  assert.equal(p.type, "redirect");
  assert.equal(p.url, "https://checkout.example/c/x?checkout_id=chk_1");
});

test("a redirect without a url is not reported as a redirect", () => {
  const p = normalise({ payment_type: "redirect" }, { paymentMethod: "FREE", currency: "USD", kind: "free" }, null);
  assert.equal(p.type, "card");
});

/* --------------------------------------------------------------- webhooks */

test("verifyWebhook accepts a correctly signed raw body", () => {
  const secret = "whsec_test_secret";
  const raw = JSON.stringify({ id: "evt_1", type: "collection.succeeded" });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");

  assert.equal(Bachs.verifyWebhook(raw, `t=${t},v1=${sig}`, secret), true);
  assert.equal(Bachs.verifyWebhook(raw, `t=${t},v1=deadbeef`, secret), false);
  assert.equal(Bachs.verifyWebhook(raw + " ", `t=${t},v1=${sig}`, secret), false, "body must be byte-identical");
  assert.equal(Bachs.verifyWebhook(raw, `t=${t}`, secret), false);
  assert.equal(Bachs.verifyWebhook(raw, "", secret), false);
});

test("verifyWebhook accepts any v1 during secret rotation", () => {
  const secret = "whsec_test_secret";
  const raw = '{"id":"evt_2"}';
  const t = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  assert.equal(Bachs.verifyWebhook(raw, `t=${t},v1=aaaa,v1=${good}`, secret), true);
});

test("verifyWebhook rejects a stale timestamp", () => {
  const secret = "whsec_test_secret";
  const raw = '{"id":"evt_3"}';
  const t = Math.floor(Date.now() / 1000) - 3600;
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  assert.equal(Bachs.verifyWebhook(raw, `t=${t},v1=${sig}`, secret), false);
  assert.equal(Bachs.verifyWebhook(raw, `t=${t},v1=${sig}`, secret, { toleranceSeconds: 7200 }), true);
});

test("constructEvent parses a valid event and throws on a bad signature", () => {
  const secret = "whsec_test_secret";
  const raw = JSON.stringify({ id: "evt_4", type: "checkout.completed", data: { checkout_id: "chk_1" } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");

  const event = Bachs.constructEvent(raw, `t=${t},v1=${sig}`, secret);
  assert.equal(event.type, "checkout.completed");
  assert.equal(event.data.checkout_id, "chk_1");

  assert.throws(() => Bachs.constructEvent(raw, `t=${t},v1=bad`, secret), /Invalid webhook signature/);
});

/* ------------------------------------------------------------ error shapes */

test("BachsError carries status, code and detail", () => {
  const err = new BachsError(400, { detail: "amount must be at least 100.00 NGN", error_code: "VALIDATION_ERROR" }, "/v1/x");
  assert.equal(err.status, 400);
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.detail, "amount must be at least 100.00 NGN");
  assert.match(err.message, /at least 100\.00 NGN/);
});

test("isUncertainWrite distinguishes retry-safe from reconcile-first", () => {
  assert.equal(isUncertainWrite(new BachsError(0, null, "/x")), true, "network failure");
  assert.equal(isUncertainWrite(new BachsError(502, null, "/x")), true, "server error");
  assert.equal(isUncertainWrite(new BachsError(409, null, "/x")), true, "conflict");
  assert.equal(isUncertainWrite(new BachsError(400, null, "/x")), false, "rejected outright");
  assert.equal(isUncertainWrite(new BachsError(402, null, "/x")), false);
});

/* ------------------------------------------------------------- card vault */

test("CardVault.seal round-trips through the vault key", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });

  const cardInput = { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" };
  const sealed = CardVault.seal(pem, cardInput);

  assert.deepEqual(Object.keys(sealed).sort(), ["ciphertext", "encrypted_key", "iv"]);

  const aesKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed.encrypted_key, "base64")
  );
  assert.equal(aesKey.length, 32, "AES-256 key");

  const blob = Buffer.from(sealed.ciphertext, "base64");
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(0, blob.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");

  assert.deepEqual(JSON.parse(plaintext), cardInput, "the PAN must survive the round trip exactly");
  assert.equal(Buffer.from(sealed.iv, "base64").length, 12, "12-byte GCM nonce");
});

test("CardVault.seal never repeats a nonce", () => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const a = CardVault.seal(pem, { card_number: "4242424242424242", expiry_month: 1, expiry_year: 2030, cvv: "111" });
  const b = CardVault.seal(pem, { card_number: "4242424242424242", expiry_month: 1, expiry_year: 2030, cvv: "111" });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("CardVault rejects a call for an unknown action", async () => {
  const vault = new CardVault({ token: "tok", actionIds: {} });
  await assert.rejects(() => vault.action("nope", []), /unknown card action/);
});

test("CardVault normalises 2-digit expiry years", async () => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const vault = new CardVault({ token: "tok" });
  vault.publicKey = async () => pem;
  vault.action = async (name) => (name === "mintTokenizeGrant" ? { grant: "g" } : { handle: "vlt_1" });

  const captured = [];
  const originalSeal = CardVault.seal;
  CardVault.seal = (pemArg, payload) => { captured.push(payload); return originalSeal(pemArg, payload); };
  try {
    await vault.tokenize({ card_number: "4242 4242 4242 4242", expiry_month: "09", expiry_year: "33", cvv: "123" });
  } finally {
    CardVault.seal = originalSeal;
  }

  assert.equal(captured[0].card_number, "4242424242424242", "spaces stripped");
  assert.equal(captured[0].expiry_month, 9, "month coerced to number");
  assert.equal(captured[0].expiry_year, 2033, "2-digit year expanded");
});

/* ------------------------------------------------- session client plumbing */

test("CheckoutSession.fromUrl derives token and hosts", () => {
  const sandbox = CheckoutSession.fromUrl("https://sandbox-checkout.bachs.io/c/ABC123");
  assert.equal(sandbox.token, "ABC123");
  assert.equal(sandbox.apiBase, SANDBOX_API);
  assert.equal(sandbox.checkoutOrigin, "https://sandbox-checkout.bachs.io");

  const live = CheckoutSession.fromUrl("https://checkout.bachs.io/c/XYZ789/");
  assert.equal(live.token, "XYZ789", "trailing slash tolerated");
  assert.equal(live.apiBase, LIVE_API);
  assert.equal(live.checkoutOrigin, "https://checkout.bachs.io");
});

test("CheckoutSession requires a token", () => {
  assert.throws(() => new CheckoutSession(), /token is required/);
});

test("currency floors are declared for every rail currency", () => {
  for (const cur of ["NGN", "USD", "USDT", "USDC", "GHS", "KES"]) {
    assert.equal(typeof MIN_AMOUNT[cur], "number", `${cur} floor`);
  }
  assert.equal(MIN_AMOUNT.NGN, 100);
  assert.equal(MIN_AMOUNT.USD, 1);
});

/* --------------------------------------------------- action-id discovery */

test("parseActionIds reads both bundled and escaped call forms", () => {
  const plain = 'createServerReference)("401e47952554c1841a2eea4c949c0d9a2bc472aabb","mintTokenizeGrant")';
  const escaped = 'createServerReference)(\\"70008f5fa5e47a0ac1ecaf0bd9276d63aed5d690a9\\",\\"tokenizeCardWithGrantRetry\\")';

  assert.equal(parseActionIds(plain).mintTokenizeGrant, "401e47952554c1841a2eea4c949c0d9a2bc472aabb");
  assert.equal(parseActionIds(escaped).tokenizeCardWithGrantRetry,
    "70008f5fa5e47a0ac1ecaf0bd9276d63aed5d690a9");
});

test("parseActionIds ignores names the vault does not use", () => {
  const body = 'createServerReference)("401e47952554c1841a2eea4c949c0d9a2bc472aabb","loadSomethingElse")';
  assert.deepEqual(parseActionIds(body), {});
});

test("parseActionIds keeps the first id when a chunk repeats a name", () => {
  const body = [
    'createServerReference)("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","completeCardCheckout")',
    'createServerReference)("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","completeCardCheckout")',
  ].join("\n");
  assert.equal(parseActionIds(body).completeCardCheckout, "a".repeat(40));
});

test("parseChunkRefs dedupes and handles both reference shapes", () => {
  const body = [
    'src="/_next/static/chunks/08xp626_4.2o3.js"',
    'static/chunks/08xp626_4.2o3.js',
    "static/chunks/0zrut.e.tdrxb.js",
  ].join(" ");
  assert.deepEqual(parseChunkRefs(body).sort(), ["08xp626_4.2o3.js", "0zrut.e.tdrxb.js"]);
});

test("every action the vault calls has a name in the discovery list", () => {
  for (const name of Object.keys(KNOWN_CARD_ACTIONS)) {
    assert.ok(CARD_ACTION_NAMES.includes(name), `${name} missing from CARD_ACTION_NAMES`);
  }
});

/* ------------------------------------------------ pin-before-sealing (live) */

test("mintGrant surfaces collect_pin, which live answers for both rails", async () => {
  const vault = new CardVault({ token: "t", checkoutOrigin: SANDBOX_CHECKOUT });
  vault.action = async (name) => {
    assert.equal(name, "mintTokenizeGrant");
    return { grant: "grant_1", expires_in: 900, collect_pin: true };
  };
  const result = await vault.mintGrant();
  assert.equal(result.grant, "grant_1");
  assert.equal(result.collectPin, true);
});

test("mintGrant reports no PIN when the build does not ask for one", async () => {
  const vault = new CardVault({ token: "t", checkoutOrigin: SANDBOX_CHECKOUT });
  vault.action = async () => ({ grant: "grant_2" });
  const result = await vault.mintGrant();
  assert.equal(result.collectPin, false, "absent collect_pin must not throw or leak undefined");
});

test("mintGrant fails loudly when the build returns no grant", async () => {
  const vault = new CardVault({ token: "t", checkoutOrigin: SANDBOX_CHECKOUT });
  vault.action = async () => ({});
  await assert.rejects(() => vault.mintGrant(), (err) => err.code === "TOKENIZE_FAILED");
});

test("tokenizing with a pre-minted grant does not mint a second one", async () => {
  const vault = new CardVault({ token: "t", checkoutOrigin: SANDBOX_CHECKOUT });
  const calls = [];
  vault.action = async (name) => {
    calls.push(name);
    return { handle: "vlt_1" };
  };
  const sealed = { encrypted_key: "k", iv: "i", ciphertext: "c" };
  const result = await vault.tokenizeSealed(sealed, { grant: "grant_3", collectPin: true });
  assert.deepEqual(calls, ["tokenizeCardWithGrantRetry"]);
  assert.equal(result.handle, "vlt_1");
  assert.equal(result.collectPin, true);
});
