/**
 * Card verification: the guided part.
 *
 * A card charge is not "charge and done". The API answers with a `next_action` that tells you what
 * to collect next - an OTP, a card PIN, an address for AVS, or a redirect to the issuer's page - and
 * after each answer it may ask for something else. This module turns that into an explicit step so
 * your UI switches on data instead of guessing:
 *
 *   const step = nextCardStep(completeResponse);
 *   // { action: "collect_otp", type: "otp", canResend: true, chargeId: "ch_..." }
 *   // { action: "collect_pin" | "collect_avs" | "redirect" | "confirm_inline" | "poll" | "done" }
 *
 * `driveCardVerification` runs that loop for you and asks a callback for each answer.
 */

const OTP_TYPES = new Set(["requires_otp", "otp"]);
const PIN_TYPES = new Set(["requires_pin", "pin"]);
const AVS_TYPES = new Set(["requires_avs", "avs"]);

/** AVS fields the checkout collects, per the hosted flow. */
export const AVS_FIELDS = ["line1", "city", "state", "postal_code", "country"];

/**
 * What verification (if any) the provider is asking for right now.
 *
 * @param {object} result a `/complete` or `authorizeCardStep` response
 * @returns {{type: "otp"|"pin"|"avs"|"redirect", canResend?: boolean, url?: string, fields?: string[], nextAction?: object}|null}
 */
export function cardChallenge(result) {
  if (!result || typeof result !== "object") return null;

  const next = result.next_action || null;
  const nextType = String(next?.type || "").toLowerCase();
  const authModel = String(result.auth_model || "").toLowerCase();
  const paymentType = String(result.payment_type || "").toLowerCase();
  const redirectUrl = next?.redirect_url || next?.redirect_to_url?.url || result.payment_url || null;

  // A redirect to the issuer is a challenge we cannot collect in-page.
  if ((paymentType === "redirect" || nextType.includes("redirect") || authModel.includes("redirect")) && redirectUrl) {
    return { type: "redirect", url: redirectUrl, nextAction: next };
  }
  if (OTP_TYPES.has(nextType) || OTP_TYPES.has(authModel)) {
    return { type: "otp", canResend: next?.can_resend === true, nextAction: next };
  }
  if (PIN_TYPES.has(nextType) || PIN_TYPES.has(authModel)) {
    return { type: "pin", nextAction: next };
  }
  if (AVS_TYPES.has(nextType) || AVS_TYPES.has(authModel)) {
    return { type: "avs", fields: AVS_FIELDS, nextAction: next };
  }
  return null;
}

/**
 * The next thing to do with a card charge. Pure and total: always returns a step.
 *
 * @param {object} result a `/complete` or `authorizeCardStep` response
 * @param {{chargeId?: string}} [fallback]
 * @returns {{action: "collect_otp"|"collect_pin"|"collect_avs"|"redirect"|"confirm_inline"|"poll"|"done",
 *            chargeId: string|null, type?: string, canResend?: boolean, url?: string, fields?: string[],
 *            nextAction?: object}}
 */
export function nextCardStep(result, { chargeId } = {}) {
  const id = result?.charge_id || chargeId || null;
  const challenge = cardChallenge(result);

  if (challenge?.type === "redirect") {
    return { action: "redirect", chargeId: id, type: "redirect", url: challenge.url, nextAction: challenge.nextAction };
  }
  if (challenge?.type === "otp") {
    return { action: "collect_otp", chargeId: id, type: "otp", canResend: challenge.canResend, nextAction: challenge.nextAction };
  }
  if (challenge?.type === "pin") {
    return { action: "collect_pin", chargeId: id, type: "pin", nextAction: challenge.nextAction };
  }
  if (challenge?.type === "avs") {
    return { action: "collect_avs", chargeId: id, type: "avs", fields: challenge.fields, nextAction: challenge.nextAction };
  }

  // Inline rail: the client_secret must be confirmed with Stripe Elements, in the page.
  if (result?.client_secret) {
    return { action: "confirm_inline", chargeId: id, type: "inline", clientSecret: result.client_secret };
  }

  // Nothing to collect: watch the charge.
  if (id && result?.polling_required !== false) {
    return { action: "poll", chargeId: id, type: "card" };
  }

  return { action: "done", chargeId: id, type: "card" };
}

const COLLECT_ACTIONS = new Set(["collect_otp", "collect_pin", "collect_avs"]);

/**
 * Drive verification until nothing is left to collect.
 *
 * @param {object} opts
 * @param {import("./card-vault.js").CardVault} opts.vault
 * @param {object} opts.result the first `/complete` response
 * @param {(challenge: {action: string, type: string, attempt: number, canResend?: boolean, fields?: string[]}) =>
 *          Promise<{otp?: string, pin?: string, address?: object} | string | null | undefined>} [opts.onVerification]
 * @param {number} [opts.maxAttempts]
 * @returns {Promise<{result: object, step: object, attempts: number, reason?: string}>}
 */
export async function driveCardVerification({
  vault,
  result,
  onVerification,
  onStep,
  maxAttempts = 3,
  chargeId: knownChargeId = null,
}) {
  let current = result;
  let attempts = 0;

  for (;;) {
    // A challenge response does not always repeat charge_id; fall back to the one we already have
    // rather than dropping the customer's answer on the floor.
    const step = nextCardStep(current, { chargeId: knownChargeId });
    if (!COLLECT_ACTIONS.has(step.action)) return { result: current, step, attempts };
    if (attempts >= maxAttempts) {
      return { result: current, step, attempts, reason: "max_attempts" };
    }

    const challenge = { ...step, attempt: attempts + 1 };
    const answer = await onVerification?.(challenge);
    if (answer === undefined || answer === null) {
      return { result: current, step: challenge, attempts, reason: "no_answer" };
    }

    if (!step.chargeId) {
      // The answer arrived but there is nowhere to send it. Failing loudly beats a silent dead end
      // where the customer typed a correct code and nothing happened.
      const err = new Error(
        "The issuer asked for verification, but no charge id was present to submit it against. " +
          "Pass `chargeId` (the charge from /complete) so the answer has a target."
      );
      err.code = "VERIFICATION_NO_CHARGE_ID";
      err.step = challenge;
      err.response = current;
      throw err;
    }

    attempts += 1;

    if (step.action === "collect_otp") {
      const otp = typeof answer === "string" ? answer : answer.otp;
      // A resend is not an answer: it re-issues the code without consuming an attempt's worth of
      // verification, but we still count it so a UI cannot loop forever.
      if (typeof answer === "object" && answer.resend) {
        current = await vault.authorizeOtp({ chargeId: step.chargeId, resend: true });
      } else {
        current = await vault.authorizeOtp({ chargeId: step.chargeId, otp });
      }
    } else if (step.action === "collect_pin") {
      const pin = typeof answer === "string" ? answer : answer.pin;
      current = await vault.authorizePin({ chargeId: step.chargeId, pin });
    } else {
      const address = typeof answer === "string" ? { line1: answer } : answer.address ?? answer;
      current = await vault.submitAvs({ chargeId: step.chargeId, address });
    }

    // Hand the raw response back so a caller can log it. Diagnosing a rejected code is otherwise
    // guesswork: the response says whether the code was wrong, expired, or already answered.
    if (typeof onStep === "function") {
      await onStep({ step: challenge, response: current });
    }
  }
}
