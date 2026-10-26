/**
 * Card payments without a redirect, without a card iframe, and without plaintext card data ever
 * reaching your server's storage.
 *
 * Bachs' hosted checkout seals card details in the page with a public RSA key, then posts the sealed
 * blob to its own Next.js server actions. This module does exactly the same thing from your server or
 * from a browser helper:
 *
 *   1. GET  {checkoutOrigin}/api/vault/public-key      -> RSA-OAEP-256 (SPKI) public key
 *   2. AES-256-GCM encrypt {card_number, expiry_month, expiry_year, cvv}
 *   3. Wrap the AES key with RSA-OAEP-SHA256           -> {encrypted_key, iv, ciphertext}
 *   4. POST {checkoutOrigin}/c/{token} with `Next-Action: <mintTokenizeGrant>`  -> {grant}
 *   5. ... `tokenizeCardWithGrantRetry`                -> {handle: "vlt_...", brand, last4}
 *   6. ... `completeCardCheckout`                      -> {charge_id, payment_type, next_action}
 *
 * ⚠️  The action ids below belong to the sandbox checkout build. Production is a different build with
 * different ids, so resolve them before charging live:
 *
 *     node scripts/discover-actions.mjs https://checkout.bachs.io <checkout-token>
 *
 * then pass them in (`new CheckoutSession(token, { cardActionIds })` or `new CardVault({ actionIds })`).
 * If the build changes underneath you, requests fail with ACTION_STALE instead of a mystery 404.
 */

import crypto from "node:crypto";

const UA = "bachs-checkout/0.1.0 (+https://github.com/Marvellye/Bachs-Checkout)";

/** Server-action ids from the sandbox checkout build (indicative only - see the warning above). */
export const KNOWN_CARD_ACTIONS = {
  mintTokenizeGrant: "401e47952554c1841a2eea4c949c0d9a2bc472aabb",
  tokenizeCardWithGrantRetry: "70008f5fa5e47a0ac1ecaf0bd9276d63aed5d690a9",
  completeCardCheckout: "78c10d5fadf85ecdb798e781a46ace709ca32ee329",
  authorizePinViaVault: "609fb1f9e88b842d448abfa03c92b5143cce7a61fc",
  authorizeCardStep: "601d19c6512a8e072046ffb28cec658c7461c0d371",
  pollChargeStatus: "607d05283b5d331443eb865807eb62c0e5a7d4d436",
};

export class CardVault {
  /**
   * @param {object} opts
   * @param {string} opts.token checkout token (last segment of checkout_url)
   * @param {string} [opts.checkoutOrigin]
   * @param {Record<string,string>} [opts.actionIds] discovered ids for this build
   * @param {number} [opts.timeoutMs]
   */
  constructor({ token, checkoutOrigin = "https://sandbox-checkout.bachs.io", actionIds, timeoutMs = 45000 } = {}) {
    if (!token) throw new Error("token is required");
    this.token = token;
    this.origin = checkoutOrigin.replace(/\/+$/, "");
    this.actions = { ...KNOWN_CARD_ACTIONS, ...(actionIds || {}) };
    this.timeoutMs = timeoutMs;
  }

  /** Fetch the vault's RSA-OAEP-256 public key (PEM, SPKI). */
  async publicKey() {
    const res = await fetch(`${this.origin}/api/vault/public-key`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`vault public key -> HTTP ${res.status} at ${this.origin}`);
    const { public_key_pem: pem } = await res.json();
    if (!pem) throw new Error("vault public key response carried no public_key_pem");
    return pem;
  }

  /**
   * Seal card data: AES-256-GCM with a fresh key, wrapped by RSA-OAEP-SHA256.
   *
   * WebCrypto appends the GCM auth tag to the ciphertext, so we concatenate it the same way -
   * the wire format must match what the hosted checkout sends.
   *
   * @param {string} publicKeyPem
   * @param {{card_number: string, expiry_month: number|string, expiry_year: number|string, cvv: string, cardholder_name?: string}} card
   * @param {string} [pin]
   * @returns {{encrypted_key: string, iv: string, ciphertext: string}}
   */
  static seal(publicKeyPem, card, pin) {
    const payload = pin ? { ...card, pin } : { ...card };
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const sealed = Buffer.concat([body, cipher.getAuthTag()]);

    const wrapped = crypto.publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      aesKey
    );

    return {
      encrypted_key: wrapped.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: sealed.toString("base64"),
    };
  }

  /**
   * Call one of the checkout's server actions. Body is a JSON argument array; the response is an RSC
   * "flight" stream whose JSON rows are what we want.
   */
  async action(name, args) {
    const id = this.actions[name];
    if (!id) throw new Error(`unknown card action "${name}"`);

    const res = await fetch(`${this.origin}/c/${encodeURIComponent(this.token)}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "text/x-component",
        "Next-Action": id,
        Origin: this.origin,
        Referer: `${this.origin}/c/${this.token}`,
        "User-Agent": UA,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();

    // A redeployed checkout answers 404 (or an RSC error) for a retired action id.
    const stale = res.status === 404 || /server action .*not found|Could not find the module/i.test(text);
    if (stale) {
      const err = new Error(
        `card action "${name}" is stale for this build - refresh ids with scripts/discover-actions.mjs`
      );
      err.code = "ACTION_STALE";
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`card action "${name}" -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.code = "ACTION_FAILED";
      throw err;
    }

    const rows = [];
    for (const line of text.split("\n")) {
      const m = /^[0-9a-z]+:(.*)$/i.exec(line.trim());
      if (!m) continue;
      try { rows.push(JSON.parse(m[1])); } catch { /* non-JSON flight row */ }
    }
    return rows.find((r) => r && typeof r === "object" && !Array.isArray(r) && !("a" in r)) ?? rows;
  }

  /** Seal locally, then tokenize. Returns a vault handle (`vlt_...`), brand and last4. */
  async tokenize(card) {
    const pem = await this.publicKey();
    const sealed = CardVault.seal(pem, {
      card_number: String(card.card_number ?? card.number ?? "").replace(/\s+/g, ""),
      expiry_month: Number(card.expiry_month ?? card.exp_month),
      expiry_year: normalizeYear(card.expiry_year ?? card.exp_year),
      cvv: String(card.cvv ?? card.cvc ?? ""),
      ...((card.cardholder_name || card.name) ? { cardholder_name: card.cardholder_name || card.name } : {}),
    }, card.pin);
    return this.tokenizeSealed(sealed);
  }

  /**
   * Tokenize a payload that was already sealed elsewhere - the browser/server split.
   * Your page seals with `sealCard()` from `bachs-checkout/browser`, your server relays the
   * ciphertext here and never sees a PAN.
   *
   * @param {{encrypted_key: string, iv: string, ciphertext: string}} sealed
   */
  async tokenizeSealed(sealed) {
    if (!sealed?.ciphertext || !sealed?.encrypted_key || !sealed?.iv) {
      throw new Error("tokenizeSealed: expected { encrypted_key, iv, ciphertext }");
    }
    const grant = await this.action("mintTokenizeGrant", [this.token]);
    const tok = await this.action("tokenizeCardWithGrantRetry", [this.token, grant.grant, sealed]);
    const handle = tok?.handle ?? tok?.[0]?.handle;
    if (!handle) {
      const err = new Error(`tokenize returned no handle: ${JSON.stringify(tok).slice(0, 300)}`);
      err.code = "TOKENIZE_FAILED";
      err.body = tok;
      throw err;
    }
    return { ...tok, handle, collectPin: grant.collect_pin === true };
  }

  /** Fire the card payment for a tokenized handle. */
  async complete({ handle, quoteId, deviceInformation }) {
    const result = await this.action("completeCardCheckout", [
      this.token,
      handle,
      quoteId,
      deviceInformation ? { device_information: deviceInformation } : {},
    ]);
    return result ?? {};
  }

  /* ---------------------------------------------------- verification steps */

  /**
   * Answer an OTP challenge. The payload shape is what the hosted checkout sends:
   * `{ charge_id, type: "otp", otp }`, or `{ charge_id, type: "resend_otp" }` for a resend.
   *
   * A wrong code is not an error: the response comes back with `status: "failed"` and a
   * `next_action.type` of `requires_otp`, so the caller can re-prompt.
   *
   * @param {{chargeId: string, otp?: string, resend?: boolean}} input
   */
  authorizeOtp({ chargeId, otp, resend = false } = {}) {
    if (!chargeId) throw new Error("authorizeOtp: chargeId is required");
    if (!resend && !otp) throw new Error("authorizeOtp: otp is required (or pass resend: true)");
    const payload = resend
      ? { charge_id: chargeId, type: "resend_otp" }
      : { charge_id: chargeId, type: "otp", otp: String(otp).trim() };
    return this.action("authorizeCardStep", [this.token, payload]);
  }

  /**
   * Answer an address-verification (AVS) challenge.
   * @param {{chargeId: string, address: {line1: string, city: string, state: string, postal_code: string, country?: string}}} input
   */
  submitAvs({ chargeId, address } = {}) {
    if (!chargeId) throw new Error("submitAvs: chargeId is required");
    if (!address?.line1 || !address?.city || !address?.state || !address?.postal_code) {
      throw new Error("submitAvs: address needs line1, city, state and postal_code");
    }
    return this.action("authorizeCardStep", [
      this.token,
      { charge_id: chargeId, type: "avs", address: { country: "NG", ...address } },
    ]);
  }

  /**
   * Submit a card PIN when the issuer asks for one after the charge (`requires_pin`).
   *
   * Signature inferred from the checkout build as `(chargeId, pin)` - unlike the OTP action this one
   * does not take the checkout token. Unverified against a live issuer; see README caveats.
   */
  authorizePin({ chargeId, pin } = {}) {
    if (!chargeId) throw new Error("authorizePin: chargeId is required");
    if (!pin) throw new Error("authorizePin: pin is required");
    return this.action("authorizePinViaVault", [chargeId, String(pin)]);
  }
}

function normalizeYear(year) {
  const n = Number(year);
  if (!Number.isFinite(n)) return n;
  return n < 100 ? 2000 + n : n;
}

export default CardVault;
