/**
 * Card verification: the guided branch. No network - the vault is stubbed, the shapes come from
 * fixtures captured against the sandbox build.
 *
 *   npm test
 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bachs, BachsError, CheckoutSession, CardVault } from "../src/index.js";
import {
  cardChallenge,
  nextCardStep,
  driveCardVerification,
  AVS_FIELDS,
} from "../src/card-verification.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const card = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "card.json"), "utf8"));

const CHARGE = "ch_0000000000000000000000000card02";

/** A vault whose server actions answer from a scripted list instead of the network. */
function scriptedVault(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async authorizeOtp(input) {
      calls.push({ action: "otp", ...input });
      return queue.shift();
    },
    async authorizePin(input) {
      calls.push({ action: "pin", ...input });
      return queue.shift();
    },
    async submitAvs(input) {
      calls.push({ action: "avs", ...input });
      return queue.shift();
    },
  };
}

/* ------------------------------------------------------------- next step */

test("nextCardStep asks for an OTP when the issuer requires it", () => {
  const step = nextCardStep(card.complete_requires_otp);
  assert.equal(step.action, "collect_otp");
  assert.equal(step.type, "otp");
  assert.equal(step.canResend, true);
  assert.equal(step.chargeId, "ch_0000000000000000000000000card02");
});

test("nextCardStep asks for an address (AVS)", () => {
  const step = nextCardStep(card.complete_requires_avs);
  assert.equal(step.action, "collect_avs");
  assert.deepEqual(step.fields, AVS_FIELDS);
});

test("nextCardStep asks for a PIN", () => {
  assert.equal(nextCardStep(card.complete_requires_pin).action, "collect_pin");
});

test("nextCardStep sends the customer to the issuer for a redirect challenge", () => {
  const step = nextCardStep(card.authorize_otp_redirect);
  assert.equal(step.action, "redirect");
  assert.equal(step.url, "https://issuer.example/3ds/challenge");
});

test("nextCardStep reports the inline rail instead of pretending to poll", () => {
  const step = nextCardStep(card.complete_inline);
  assert.equal(step.action, "confirm_inline");
  assert.match(step.clientSecret, /_secret_/);
});

test("nextCardStep polls a plain processing charge", () => {
  const step = nextCardStep(card.complete_processing);
  assert.equal(step.action, "poll");
  assert.equal(step.chargeId, "ch_0000000000000000000000000card01");
});

test("a wrong OTP is a re-prompt, not a dead end", () => {
  const step = nextCardStep(card.authorize_otp_wrong);
  assert.equal(step.action, "collect_otp", "status failed + requires_otp means try again");
  assert.equal(step.canResend, true);
});

test("nextCardStep falls back to the known charge id when the response omits it", () => {
  const step = nextCardStep({ next_action: null }, { chargeId: CHARGE });
  assert.equal(step.action, "poll");
  assert.equal(step.chargeId, CHARGE);
});

test("nextCardStep is total: junk in, a step out", () => {
  assert.equal(nextCardStep(null).action, "done");
  assert.equal(nextCardStep({}).action, "done");
  assert.equal(nextCardStep({ payment_type: "processing" }).action, "done");
  assert.equal(nextCardStep({ status: "succeeded" }).action, "done");
});

test("cardChallenge prefers a redirect over other challenge types", () => {
  const challenge = cardChallenge({
    auth_model: "REDIRECT",
    next_action: { type: "requires_otp" },
    payment_url: "https://checkout.example/c/x",
  });
  assert.equal(challenge.type, "redirect");
});

/* ------------------------------------------------------- request payloads */

test("authorizeOtp sends the payload shape the checkout build uses", async () => {
  const vault = new CardVault({ token: "TOK", actionIds: { authorizeCardStep: "a".repeat(42) } });
  const seen = [];
  vault.action = async (name, args) => { seen.push({ name, args }); return { status: "succeeded" }; };

  await vault.authorizeOtp({ chargeId: "ch_1", otp: " 123456 " });
  assert.equal(seen[0].name, "authorizeCardStep");
  assert.deepEqual(seen[0].args, ["TOK", { charge_id: "ch_1", type: "otp", otp: "123456" }]);

  await vault.authorizeOtp({ chargeId: "ch_1", resend: true });
  assert.deepEqual(seen[1].args, ["TOK", { charge_id: "ch_1", type: "resend_otp" }]);
});

test("authorizeOtp refuses an empty code unless it is a resend", async () => {
  const vault = new CardVault({ token: "TOK" });
  await assert.rejects(async () => vault.authorizeOtp({ chargeId: "ch_1", otp: "" }), /otp is required/);
  await assert.rejects(async () => vault.authorizeOtp({ otp: "123" }), /chargeId is required/);
});

test("submitAvs validates the address and defaults the country", async () => {
  const vault = new CardVault({ token: "TOK" });
  const seen = [];
  vault.action = async (name, args) => { seen.push({ name, args }); return { status: "pending" }; };

  await assert.rejects(
    async () => vault.submitAvs({ chargeId: "ch_1", address: { line1: "1 Main St" } }),
    /line1, city, state and postal_code/
  );

  await vault.submitAvs({
    chargeId: "ch_1",
    address: { line1: "1 Main St", city: "Lagos", state: "LA", postal_code: "100001" },
  });
  assert.deepEqual(seen[0].args[1], {
    charge_id: "ch_1",
    type: "avs",
    address: { country: "NG", line1: "1 Main St", city: "Lagos", state: "LA", postal_code: "100001" },
  });
});

test("authorizePin sends (chargeId, pin) and fills in a fresh action id", async () => {
  const vault = new CardVault({ token: "TOK" });
  let call;
  vault.action = async (name, args) => { call = { name, args }; return {}; };

  await vault.authorizePin({ chargeId: "ch_1", pin: "1234" });
  assert.equal(call.name, "authorizePinViaVault");
  assert.deepEqual(call.args, ["ch_1", "1234"], "this action takes the charge id, not the token");
});

/* ------------------------------------------------------------ the loop */

test("driveCardVerification retries after a rejected code, then settles", async () => {
  const vault = scriptedVault([card.authorize_otp_wrong, card.authorize_otp_accepted]);
  const prompts = [];

  const { result, step, attempts } = await driveCardVerification({
    vault,
    result: card.complete_requires_otp,
    onVerification: async (challenge) => {
      prompts.push(challenge.attempt);
      return { otp: challenge.attempt === 1 ? "000000" : "123456" };
    },
  });

  assert.deepEqual(prompts, [1, 2], "the customer is asked again after a wrong code");
  assert.equal(attempts, 2);
  assert.equal(vault.calls.length, 2);
  assert.equal(vault.calls[0].otp, "000000");
  assert.equal(vault.calls[1].otp, "123456");
  assert.equal(step.action, "poll", "an accepted OTP leaves only polling");
  assert.equal(result.status, "succeeded");
  assert.equal(result.charge_id, CHARGE, "the charge id survives the verification round trip");
});

test("driveCardVerification stops when the UI declines to answer", async () => {
  const vault = scriptedVault([]);
  const { result, step, attempts, reason } = await driveCardVerification({
    vault,
    result: card.complete_requires_otp,
    onVerification: async () => null,
  });

  assert.equal(reason, "no_answer");
  assert.equal(attempts, 0);
  assert.equal(vault.calls.length, 0, "nothing is submitted without an answer");
  assert.equal(step.action, "collect_otp", "the caller still gets the step to render");
  assert.equal(result.payment_type, "processing");
});

test("driveCardVerification cannot loop forever", async () => {
  const vault = scriptedVault([
    card.authorize_otp_wrong,
    card.authorize_otp_wrong,
    card.authorize_otp_wrong,
    card.authorize_otp_wrong,
  ]);
  const { step, attempts, reason } = await driveCardVerification({
    vault,
    result: card.complete_requires_otp,
    onVerification: async () => ({ otp: "111111" }),
    maxAttempts: 3,
  });

  assert.equal(attempts, 3);
  assert.equal(reason, "max_attempts");
  assert.equal(step.action, "collect_otp");
  assert.equal(vault.calls.length, 3);
});

test("driveCardVerification submits an AVS address", async () => {
  const vault = scriptedVault([card.authorize_otp_accepted]);
  const { step, attempts } = await driveCardVerification({
    vault,
    result: card.complete_requires_avs,
    onVerification: async (challenge) => {
      assert.equal(challenge.action, "collect_avs");
      return { address: { line1: "1 Main St", city: "Lagos", state: "LA", postal_code: "100001" } };
    },
  });

  assert.equal(vault.calls[0].action, "avs");
  assert.equal(vault.calls[0].address.city, "Lagos");
  assert.equal(attempts, 1);
  assert.equal(step.action, "poll");
});

test("driveCardVerification submits a PIN", async () => {
  const vault = scriptedVault([card.authorize_otp_accepted]);
  const { attempts } = await driveCardVerification({
    vault,
    result: card.complete_requires_pin,
    onVerification: async () => "1234",
  });
  assert.equal(vault.calls[0].action, "pin");
  assert.equal(vault.calls[0].pin, "1234");
  assert.equal(attempts, 1);
});

test("driveCardVerification returns immediately when nothing is challenged", async () => {
  const vault = scriptedVault([]);
  const { step, attempts } = await driveCardVerification({
    vault,
    result: card.complete_processing,
    onVerification: async () => { throw new Error("must not be called"); },
  });
  assert.equal(step.action, "poll");
  assert.equal(attempts, 0);
});

/* --------------------------------------------------- session orchestration */

// payCard mints a grant before sealing, because that response announces `collect_pin`. Keep the
// tests off the network by default; the PIN tests below override it.
const realMintGrant = CardVault.prototype.mintGrant;
beforeEach(() => {
  CardVault.prototype.mintGrant = async () => ({ grant: "grant_test", collectPin: false });
});
afterEach(() => {
  CardVault.prototype.mintGrant = realMintGrant;
});

test("payCard drives verification and waits for the outcome", async () => {
  const checkout = new CheckoutSession("TOK", { cardActionIds: {} });
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });
  checkout.waitForPayment = async () => ({ charge_status: "succeeded", amount_paid: "1.00" });

  const originalTokenize = CardVault.prototype.tokenize;
  const originalComplete = CardVault.prototype.complete;
  const originalOtp = CardVault.prototype.authorizeOtp;
  const completions = [card.complete_requires_otp];
  const otpCalls = [];
  try {
    CardVault.prototype.tokenize = async () => ({ handle: "vlt_1", brand: "visa", last4: "4242" });
    CardVault.prototype.complete = async () => completions.shift();
    CardVault.prototype.authorizeOtp = async (input) => { otpCalls.push(input); return card.authorize_otp_accepted; };

    const payment = await checkout.payCard({
      card: { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" },
      currency: "USD",
      onVerification: async ({ type }) => (type === "otp" ? { otp: "123456" } : null),
      waitForResult: true,
    });

    assert.equal(payment.type, "card");
    assert.equal(payment.chargeId, CHARGE);
    assert.equal(payment.step.action, "poll");
    assert.equal(payment.verificationAttempts, 1);
    assert.equal(payment.final.charge_status, "succeeded");
    assert.deepEqual(otpCalls[0], { chargeId: CHARGE, otp: "123456" });
  } finally {
    CardVault.prototype.tokenize = originalTokenize;
    CardVault.prototype.complete = originalComplete;
    CardVault.prototype.authorizeOtp = originalOtp;
  }
});

test("payCard hands the challenge back when no UI handler is supplied", async () => {
  const checkout = new CheckoutSession("TOK");
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });

  const originalTokenize = CardVault.prototype.tokenize;
  const originalComplete = CardVault.prototype.complete;
  try {
    CardVault.prototype.tokenize = async () => ({ handle: "vlt_1" });
    CardVault.prototype.complete = async () => card.complete_requires_otp;

    const payment = await checkout.payCard({
      card: { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" },
    });

    assert.equal(payment.step.action, "collect_otp");
    assert.equal(payment.verificationReason, "no_answer");
    assert.equal(payment.verificationAttempts, 0);
    assert.equal(payment.chargeId, CHARGE);
  } finally {
    CardVault.prototype.tokenize = originalTokenize;
    CardVault.prototype.complete = originalComplete;
  }
});

test("payCard accepts a payload sealed in the browser", async () => {
  const checkout = new CheckoutSession("TOK");
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });

  const originalSealed = CardVault.prototype.tokenizeSealed;
  const originalComplete = CardVault.prototype.complete;
  let sealedUsed = null;
  try {
    CardVault.prototype.tokenizeSealed = async (sealed) => { sealedUsed = sealed; return { handle: "vlt_b" }; };
    CardVault.prototype.complete = async () => card.complete_processing;

    const payment = await checkout.payCard({ card: { sealed: { encrypted_key: "a", iv: "b", ciphertext: "c" } } });
    assert.deepEqual(sealedUsed, { encrypted_key: "a", iv: "b", ciphertext: "c" });
    assert.equal(payment.step.action, "poll");
  } finally {
    CardVault.prototype.tokenizeSealed = originalSealed;
    CardVault.prototype.complete = originalComplete;
  }
});

test("payCard requires a card", async () => {
  const checkout = new CheckoutSession("TOK");
  await assert.rejects(() => checkout.payCard({}), /card is required/);
});

test("submitOtp returns the next step for a manual UI", async () => {
  const checkout = new CheckoutSession("TOK");
  const original = CardVault.prototype.authorizeOtp;
  try {
    CardVault.prototype.authorizeOtp = async () => card.authorize_otp_wrong;
    const { step, raw } = await checkout.submitOtp({ chargeId: CHARGE, otp: "000000" });
    assert.equal(step.action, "collect_otp", "a wrong code keeps the OTP screen open");
    assert.equal(step.chargeId, CHARGE);
    assert.equal(raw.status, "failed");
  } finally {
    CardVault.prototype.authorizeOtp = original;
  }
});

test("cardStep is pure and needs no request", () => {
  const checkout = new CheckoutSession("TOK");
  assert.equal(checkout.cardStep(card.complete_requires_otp).action, "collect_otp");
  assert.equal(checkout.cardStep({}, { chargeId: "ch_x" }).chargeId, "ch_x");
});

test("BachsError surfaces a failed verification", () => {
  const err = new BachsError(400, { detail: "Invalid OTP", error_code: "INVALID_OTP" }, "authorizeCardStep");
  assert.equal(err.code, "INVALID_OTP");
  assert.match(err.message, /Invalid OTP/);
});

/* ------------------------------------------------ pin before sealing (live) */

test("payCard asks for the PIN before sealing when the build demands one", async () => {
  const checkout = new CheckoutSession("TOK", { cardActionIds: {} });
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });

  const originalTokenize = CardVault.prototype.tokenize;
  const originalComplete = CardVault.prototype.complete;
  let pinPassedToSeal;
  const challenges = [];
  try {
    CardVault.prototype.mintGrant = async () => ({ grant: "grant_pin", collectPin: true });
    CardVault.prototype.tokenize = async (input) => {
      pinPassedToSeal = input.pin;
      return { handle: "vlt_pin", brand: "verve", last4: "4904" };
    };
    CardVault.prototype.complete = async () => ({
      payment_type: "processing",
      charge_id: "ch_pin",
      status: "processing",
    });

    const payment = await checkout.payCard({
      card: { card_number: "5060991550000000000", expiry_month: 9, expiry_year: 2030, cvv: "111" },
      currency: "NGN",
      onVerification: async (challenge) => {
        challenges.push(challenge);
        if (challenge.action === "collect_pin") return { pin: "1234" };
        return null;
      },
    });

    assert.equal(pinPassedToSeal, "1234", "the PIN must be sealed with the card, not sent later");
    assert.equal(challenges[0].action, "collect_pin");
    assert.equal(challenges[0].phase, "before_sealing");
    assert.equal(payment.chargeId, "ch_pin");
  } finally {
    CardVault.prototype.tokenize = originalTokenize;
    CardVault.prototype.complete = originalComplete;
  }
});

test("payCard refuses to guess when the PIN is needed but no handler answers", async () => {
  const checkout = new CheckoutSession("TOK", { cardActionIds: {} });
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });
  CardVault.prototype.mintGrant = async () => ({ grant: "grant_pin", collectPin: true });

  await assert.rejects(
    () =>
      checkout.payCard({
        card: { card_number: "5060991550000000000", expiry_month: 9, expiry_year: 2030, cvv: "111" },
        currency: "NGN",
      }),
    (err) => err.code === "PIN_REQUIRED" && err.step?.phase === "before_sealing"
  );
});

test("payCard explains itself when a sealed blob cannot carry a required PIN", async () => {
  const checkout = new CheckoutSession("TOK", { cardActionIds: {} });
  checkout.quote = async () => ({ quote_id: "q1", total_amount: "1.00", currency: "USD" });
  CardVault.prototype.mintGrant = async () => ({ grant: "grant_pin", collectPin: true });

  await assert.rejects(
    () =>
      checkout.payCard({
        card: { sealed: { encrypted_key: "k", iv: "i", ciphertext: "c" } },
        currency: "NGN",
      }),
    (err) => err.code === "PIN_REQUIRED" && /already sealed/.test(err.message)
  );
});
