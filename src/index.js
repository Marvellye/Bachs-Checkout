/**
 * bachs-checkout - unofficial SDK over the Bachs payments API.
 *
 * Two clients, because Bachs has two surfaces:
 *
 *   Bachs             secret key, server only  -> products, checkout sessions, payments, refunds
 *   CheckoutSession   checkout token, no key   -> the calls the hosted checkout page makes:
 *                                                detail, requirements, quote, complete, status
 *
 * The second one is what lets you build your own UI. Quote a rail, complete it, then render the raw
 * instructions yourself: bank account numbers, crypto addresses with a countdown, mobile-money
 * approval prompts. No redirect, no hosted page.
 *
 * Card data never reaches your server in plaintext: see ./card-vault.js and ./browser.js.
 */

import crypto from "node:crypto";
import { CardVault, KNOWN_CARD_ACTIONS } from "./card-vault.js";
import { discoverCardActions } from "./discover.js";

export { discoverCardActions, parseActionIds, parseChunkRefs, CARD_ACTION_NAMES } from "./discover.js";
import { nextCardStep, driveCardVerification, cardChallenge, AVS_FIELDS } from "./card-verification.js";

export const SANDBOX_API = "https://sandbox-api.bachs.io";
export const LIVE_API = "https://api.bachs.io";
export const SANDBOX_CHECKOUT = "https://sandbox-checkout.bachs.io";
export const LIVE_CHECKOUT = "https://checkout.bachs.io";

const UA = "bachs-checkout/0.1.0 (+https://github.com/Marvellye/Bachs-Checkout)";
const MOMO_CURRENCIES = ["GHS", "KES", "TZS", "UGX", "XAF", "XOF", "RWF", "MWK", "ZMW"];

/** Minimum amount a product-less session accepts, per currency. */
export const MIN_AMOUNT = {
  NGN: 100,
  USD: 1,
  USDT: 1,
  USDC: 1,
  GHS: 1,
  KES: 1,
  TZS: 1,
  UGX: 1,
  XAF: 1,
  XOF: 1,
  RWF: 1,
  MWK: 1,
  ZMW: 1,
};

/* ------------------------------------------------------------------ errors */

export class BachsError extends Error {
  /**
   * @param {number} status HTTP status, or 0 for a network/timeout failure
   * @param {any} body parsed error body
   * @param {string} path request path
   */
  constructor(status, body, path) {
    const detail =
      body && typeof body === "object" ? body.detail || body.message || body.error : body;
    super(typeof detail === "string" ? detail : `Bachs request failed (${status}) on ${path}`);
    this.name = "BachsError";
    this.status = status;
    this.code = body?.error_code || body?.failure_code || null;
    this.detail = detail ?? null;
    this.body = body;
    this.path = path;
  }
}

/**
 * True when a write might have been applied even though we saw a failure.
 * Reconcile by reading/listing before retrying; never blind-retry these.
 */
export function isUncertainWrite(err) {
  return !err?.status || err.status >= 500 || err.status === 409;
}

/* ------------------------------------------------------- private API client */

export class Bachs {
  /**
   * @param {object} opts
   * @param {string} opts.secretKey `sk_sandbox_...` or `sk_live_...`
   * @param {string} [opts.baseUrl] override; defaults from the key prefix
   * @param {number} [opts.timeoutMs]
   */
  constructor({ secretKey, baseUrl, timeoutMs = 45000 } = {}) {
    if (!secretKey) throw new Error("secretKey is required");
    this.secretKey = secretKey;
    this.baseUrl = (baseUrl || (secretKey.startsWith("sk_live") ? LIVE_API : SANDBOX_API)).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;

    this.checkoutSessions = {
      create: (body, opts) => {
        validateSessionBody(body);
        return this.#post("/v1/checkout-sessions", body, opts);
      },
      /** Raw amount, no product: `{ pricing: { currency, amount } }`. */
      createRaw: ({ amount, currency, ...rest }, opts) => {
        if (amount === undefined || !currency) throw new Error("createRaw: amount and currency are required");
        return this.checkoutSessions.create({ ...rest, pricing: { currency, amount: String(amount) } }, opts);
      },
      /** Buyer chooses the amount, bounded: `price_type: "custom"`. */
      createCustom: ({ currency, presetAmount, minimumAmount, maximumAmount, ...rest }, opts) => {
        if (!currency) throw new Error("createCustom: currency is required");
        return this.checkoutSessions.create({
          ...rest,
          pricing: {
            currency,
            price_type: "custom",
            ...(presetAmount !== undefined ? { preset_amount: String(presetAmount) } : {}),
            ...(minimumAmount !== undefined ? { minimum_amount: String(minimumAmount) } : {}),
            ...(maximumAmount !== undefined ? { maximum_amount: String(maximumAmount) } : {}),
          },
        }, opts);
      },
      /** No charge at all; the session completes without a payment instrument. */
      createFree: ({ currency, ...rest }, opts) => {
        if (!currency) throw new Error("createFree: currency is required");
        return this.checkoutSessions.create({ ...rest, pricing: { currency, price_type: "free" } }, opts);
      },
      get: (id) => this.#get(`/v1/checkout-sessions/${encodeURIComponent(id)}`),
    };

    this.products = {
      create: (body) => this.#post("/v1/products", body),
      get: (id) => this.#get(`/v1/products/${encodeURIComponent(id)}`),
      list: (query) => this.#get("/v1/products", query),
      update: (id, body) => this.#patch(`/v1/products/${encodeURIComponent(id)}`, body),
      archive: (id) => this.#post(`/v1/products/${encodeURIComponent(id)}/archive`, {}),
      unarchive: (id) => this.#post(`/v1/products/${encodeURIComponent(id)}/unarchive`, {}),
    };

    this.payments = {
      get: (id) => this.#get(`/v1/payments/${encodeURIComponent(id)}`),
      list: (query) => this.#get("/v1/payments", query),
      /** Off-session charge against a card saved at an earlier checkout. */
      charge: (body) => this.#post("/v1/charges", body),
    };

    this.refunds = {
      create: (body) => this.#post("/v1/refunds", body),
      get: (id) => this.#get(`/v1/refunds/${encodeURIComponent(id)}`),
      list: (query) => this.#get("/v1/refunds", query),
      byPayment: (paymentId) => this.#get(`/v1/refunds/by-charge/${encodeURIComponent(paymentId)}`),
    };

    this.customers = {
      create: (body) => this.#post("/v1/customers", body),
      get: (id) => this.#get(`/v1/customers/${encodeURIComponent(id)}`),
      list: (query) => this.#get("/v1/customers", query),
      update: (id, body) => this.#patch(`/v1/customers/${encodeURIComponent(id)}`, body),
      portalSession: (id, body) => this.#post(`/v1/customers/${encodeURIComponent(id)}/portal-sessions`, body),
    };

    this.subscriptions = {
      get: (id) => this.#get(`/v1/subscriptions/${encodeURIComponent(id)}`),
      list: (query) => this.#get("/v1/subscriptions", query),
      update: (id, body) => this.#patch(`/v1/subscriptions/${encodeURIComponent(id)}`, body),
      cancel: (id) => this.#send("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`),
    };

    this.webhooks = {
      create: (body) => this.#post("/v1/webhooks/endpoints", body),
      list: (query) => this.#get("/v1/webhooks/endpoints", query),
      update: (id, body) => this.#patch(`/v1/webhooks/endpoints/${encodeURIComponent(id)}`, body),
      remove: (id) => this.#send("DELETE", `/v1/webhooks/endpoints/${encodeURIComponent(id)}`),
      rotateSecret: (id) => this.#post(`/v1/webhooks/endpoints/${encodeURIComponent(id)}/rotate-secret`, {}),
      events: (query) => this.#get("/v1/webhooks/events", query),
      replay: (body) => this.#post("/v1/webhooks/replay", body),
    };

    this.balances = {
      get: () => this.#get("/v1/balances"),
      settings: () => this.#get("/v1/balance_settings"),
    };

    this.account = {
      me: () => this.#get("/v1/accounts/me"),
      paymentMethods: () => this.#get("/v1/payment-methods"),
      paymentRails: (query) => this.#get("/v1/payment-methods/rails", query),
      currencies: () => this.#get("/v1/currencies/supported"),
      payoutCurrencies: () => this.#get("/v1/currencies/payout-supported"),
    };
  }

  /** Escape hatch: any endpoint this wrapper does not cover. */
  request(path, { method = "GET", body, query, idempotencyKey } = {}) {
    return this.#send(method, path, body, query, idempotencyKey);
  }

  /** Build a CheckoutSession for a session this client created. */
  session(checkoutUrl) {
    return CheckoutSession.fromUrl(checkoutUrl ?? (() => { throw new Error("checkoutUrl is required"); })());
  }

  async #send(method, path, body, query, idempotencyKey) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const headers = { Accept: "application/json", "User-Agent": UA };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Every public write carries an idempotency key; a retry after a timeout must not double-charge.
    if (method !== "GET") headers["Idempotency-Key"] = idempotencyKey || crypto.randomUUID();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { ...headers, Authorization: `Bearer ${this.secretKey}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const e = new BachsError(0, null, path);
      e.cause = err;
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new BachsError(res.status, parsed, path);
    return parsed;
  }

  #get(path, query) { return this.#send("GET", path, undefined, query); }
  #post(path, body, opts = {}) {
    return this.#send("POST", path, body ?? {}, undefined, opts?.idempotencyKey);
  }
  #patch(path, body) { return this.#send("PATCH", path, body ?? {}); }

  /* ---------------------------------------------------------------- webhooks */

  /**
   * Verify `X-Bachs-Signature-V2` against the RAW request body.
   * Header shape: `t=<unix>,v1=<hex>[,v1=<hex>]` (more than one v1 during secret rotation).
   *
   * @param {string|Buffer} rawBody body exactly as received, before JSON.parse
   * @param {string} signatureHeader the header value
   * @param {string} secret `whsec_...`
   * @param {{toleranceSeconds?: number}} [opts]
   * @returns {boolean}
   */
  static verifyWebhook(rawBody, signatureHeader, secret, { toleranceSeconds = 300 } = {}) {
    if (!signatureHeader || !secret) return false;
    const parts = String(signatureHeader).split(",").map((p) => p.split("="));
    const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
    if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    return parts
      .filter(([k]) => k === "v1")
      .some(([, sig]) =>
        Boolean(sig) &&
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      );
  }

  /** Verify and parse in one step. Throws a BachsError on a bad signature. */
  static constructEvent(rawBody, signatureHeader, secret, opts) {
    if (!Bachs.verifyWebhook(rawBody, signatureHeader, secret, opts)) {
      throw new BachsError(400, { detail: "Invalid webhook signature" }, "webhook");
    }
    return JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  }
}

/* --------------------------------------------------------- body validation */

function validateSessionBody(body) {
  if (!body || typeof body !== "object") throw new Error("checkoutSessions.create: a body is required");
  const hasCart = Array.isArray(body.product_cart) && body.product_cart.length > 0;
  const hasPricing = body.pricing && typeof body.pricing === "object";
  if (hasCart && hasPricing) {
    throw new Error("checkoutSessions.create: product_cart and pricing are mutually exclusive");
  }
  if (!hasCart && !hasPricing) throw new Error("checkoutSessions.create: pass product_cart or pricing");
  if (hasPricing) {
    if (!body.pricing.currency) throw new Error("checkoutSessions.create: pricing.currency is required");
    const type = body.pricing.price_type;
    if (type !== "free" && type !== "custom" && body.pricing.amount === undefined) {
      throw new Error("checkoutSessions.create: pricing.amount is required for a fixed price");
    }
  }
}

/* -------------------------------------------------------- public checkout API */

/**
 * Map a friendly rail choice onto Bachs' `payment_method` + currency pair.
 * @returns {{paymentMethod: string, currency: string, kind: "card"|"bank_transfer"|"crypto"|"mobile_money"|"other"}}
 */
export function resolveRail({ rail = "card", currency } = {}) {
  const r = String(rail).toLowerCase();

  if (r === "card" || r === "ngn_card" || r === "usd_card") {
    const cur = (currency || "USD").toUpperCase();
    return { paymentMethod: cur === "NGN" ? "NGN_CARD" : "USD_CARD", currency: cur, kind: "card" };
  }
  if (r === "bank" || r === "bank_transfer" || r === "ngn_bank_transfer") {
    return { paymentMethod: "NGN_BANK_TRANSFER", currency: "NGN", kind: "bank_transfer" };
  }
  if (r === "crypto" || r === "usdt" || r === "usdc" || r.startsWith("usdt_") || r.startsWith("usdc_") ||
      /^(btc|eth|bnb|sol|celo)_/.test(r)) {
    return { paymentMethod: "CRYPTO", currency: (currency || "USDT_TRC20").toUpperCase(), kind: "crypto" };
  }
  if (r === "momo" || r === "mobile_money" || r.startsWith("momo_")) {
    if (r.startsWith("momo_")) {
      const cur = r.split("_")[1].toUpperCase();
      return { paymentMethod: `MOMO_${cur}`, currency: cur, kind: "mobile_money" };
    }
    const cur = (currency || "GHS").toUpperCase();
    if (!MOMO_CURRENCIES.includes(cur)) {
      throw new Error(`mobile money has no ${cur} corridor; use one of ${MOMO_CURRENCIES.join(", ")}`);
    }
    return { paymentMethod: `MOMO_${cur}`, currency: cur, kind: "mobile_money" };
  }
  return { paymentMethod: String(rail).toUpperCase(), currency: (currency || "USD").toUpperCase(), kind: "other" };
}

/**
 * One checkout session, drivable from your server or the browser.
 * The checkout token is the credential - no secret key needed.
 */
export class CheckoutSession {
  /**
   * @param {string} token the last path segment of `checkout_url`
   * @param {{apiBase?: string, checkoutOrigin?: string, environment?: "live"|"sandbox",
   *   timeoutMs?: number, cardActionIds?: Record<string,string>}} [opts]
   */
  constructor(token, {
    apiBase,
    checkoutOrigin,
    environment,
    timeoutMs = 45000,
    cardActionIds = null,
  } = {}) {
    if (!token) throw new Error("token is required");

    // A live token is only valid against the live API, so the pair has to move together.
    // Callers pass `environment`, or an apiBase which already says which side it is; the bare
    // default stays sandbox because that is what a test key produces.
    const live = environment
      ? String(environment).toLowerCase() === "live"
      : apiBase
        ? !String(apiBase).includes("sandbox")
        : false;

    this.token = token;
    this.environment = live ? "live" : "sandbox";
    this.apiBase = (apiBase || (live ? LIVE_API : SANDBOX_API)).replace(/\/+$/, "");
    this.checkoutOrigin = (checkoutOrigin || (live ? LIVE_CHECKOUT : SANDBOX_CHECKOUT)).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    // Production builds carry different server-action ids; pass discovered ones here.
    this.cardActionIds = cardActionIds;
  }

  /** Derive the client from a `checkout_url` returned by Bachs. */
  static fromUrl(checkoutUrl) {
    if (!checkoutUrl) throw new Error("checkoutUrl is required");
    const u = new URL(checkoutUrl);
    const token = u.pathname.replace(/\/+$/, "").split("/").pop();
    const isSandbox = u.hostname.includes("sandbox");
    return new CheckoutSession(token, {
      apiBase: isSandbox ? SANDBOX_API : LIVE_API,
      checkoutOrigin: `${u.protocol}//${u.hostname}`,
    });
  }

  /**
   * Resolve the card-vault action ids for this session's own build. Sandbox and live differ, and a
   * redeploy rotates them, so call this before a card charge rather than trusting the constants.
   */
  async refreshCardActions({ maxChunks } = {}) {
    const result = await discoverCardActions(this.checkoutOrigin, this.token, maxChunks ? { maxChunks } : {});
    this.cardActionIds = { ...(this.cardActionIds || {}), ...result.ids };
    return { ...result, checkoutOrigin: this.checkoutOrigin };
  }

  /** The vault for this session, carrying any discovered action ids. */
  #vault() {
    return new CardVault({
      token: this.token,
      checkoutOrigin: this.checkoutOrigin,
      ...(this.cardActionIds ? { actionIds: this.cardActionIds } : {}),
    });
  }

  async #call(path, { method = "GET", body } = {}) {
    const res = await fetch(
      `${this.apiBase}/v1/public/checkouts/${encodeURIComponent(this.token)}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": UA,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }
    );
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new BachsError(res.status, parsed, path);
    return parsed;
  }

  /** Amount, currency, available rails, branding - what a checkout screen renders. */
  detail() { return this.#call("/detail"); }

  /** Which dynamic fields this rail needs next (mobile network, phone number, ...). */
  requirements({ paymentMethod, currency, paymentRail }) {
    return this.#call("/requirements", {
      method: "POST",
      body: { payment_method: paymentMethod, currency, ...(paymentRail ? { payment_rail: paymentRail } : {}) },
    });
  }

  /** Lock the exchange rate and fee for a rail. Quotes expire in minutes - re-quote, don't replay. */
  quote({ paymentMethod, currency, paymentRail }) {
    return this.#call("/get-quote", {
      method: "POST",
      body: { payment_method: paymentMethod, currency, ...(paymentRail ? { payment_rail: paymentRail } : {}) },
    });
  }

  /** Fire the payment. The response shape depends on the rail - see normalise(). */
  complete({ paymentMethod, quoteId, ...rest }) {
    return this.#call("/complete", {
      method: "POST",
      body: { payment_method: paymentMethod, quote_id: quoteId, ...rest },
    });
  }

  /** Change the amount on a custom-priced session (the buyer picked a number in your UI). */
  setAmount(amount) {
    return this.#call("/set-amount", { method: "POST", body: { amount: String(amount) } });
  }

  chargeStatus(chargeId) {
    return this.#call(`/charges/${encodeURIComponent(chargeId)}/status`);
  }

  /** Mobile money: submit the OTP / approval the network asked for. */
  authorizeMobileMoney(body) {
    return this.#call("/mobile-money/authorize", { method: "POST", body });
  }

  /** Card: confirm with a payment token minted elsewhere (e.g. Whop Elements). */
  confirmPayment(body) {
    return this.#call("/confirm-payment", { method: "POST", body });
  }

  /**
   * Quote and pay a rail in one call, normalised for rendering.
   *
   * @param {object} opts
   * @param {string} [opts.rail] card | bank | crypto | momo | momo_ghs | free
   * @param {string} [opts.currency]
   * @param {string} [opts.phone] mobile money number, `+countrycode…`
   * @param {string} [opts.paymentRail] mobile money network (mtn, vodafone, ...)
   * @param {{card_number: string, expiry_month: number|string, expiry_year: number|string, cvv: string}} [opts.card]
   * @returns {Promise<NormalisedPayment>}
   */
  async pay({ rail = "card", currency, phone, paymentRail, card, cardOptions } = {}) {
    if (String(rail).toLowerCase() === "free") {
      const result = await this.complete({});
      return normalise(result, { paymentMethod: "FREE", currency: currency || "USD", kind: "free" }, null);
    }

    const r = resolveRail({ rail, currency });
    const quote = await this.quote({ paymentMethod: r.paymentMethod, currency: r.currency, paymentRail });

    if (r.kind === "card" && card) {
      const vault = this.#vault();
      const { handle } = await vault.tokenize(card);
      const result = await vault.complete({
        handle,
        quoteId: quote.quote_id,
        deviceInformation: cardOptions?.deviceInformation,
      });
      return normalise(result, r, quote);
    }

    const result = await this.complete({
      paymentMethod: r.paymentMethod,
      quoteId: quote.quote_id,
      ...(paymentRail ? { payment_rail: paymentRail } : {}),
      ...(phone ? { phone_number: phone } : {}),
    });
    return normalise(result, r, quote);
  }

  /**
   * Pay by card and let the API drive verification.
   *
   * The charge may come back asking for an OTP, a PIN, an address, or a redirect to the issuer.
   * `onVerification` is called once per challenge with `{ action, type, attempt, canResend, fields }`;
   * return `{ otp }`, `{ pin }`, `{ address }`, a bare string, or `null` to stop and hand the step
   * back to your own UI.
   *
   * The resolved value is a normalised card payment plus `step` (what to do next, if anything) and,
   * when `waitForResult` is set, `final`.
   *
   * @param {object} opts
   * @returns {Promise<NormalisedPayment & {step: object, verificationAttempts: number, final?: object}>}
   */
  async payCard({
    card,
    currency = "USD",
    cardOptions,
    onVerification,
    onStep,
    maxVerificationAttempts = 3,
    waitForResult = false,
    waitOptions,
  } = {}) {
    if (!card) throw new Error("payCard: card is required");

    const rail = resolveRail({ rail: "card", currency });
    const quote = await this.quote({ paymentMethod: rail.paymentMethod, currency: rail.currency });

    const vault = this.#vault();

    // The grant announces `collect_pin` before any card data is sealed. Most Nigerian issuers
    // want the PIN inside the sealed payload, before a charge exists, which is a different flow
    // from the post-charge PIN challenge that authorizePin answers.
    const grant = await vault.mintGrant();
    let pin = cardOptions?.pin ?? null;

    if (grant.collectPin && !pin) {
      const challenge = {
        action: "collect_pin",
        phase: "before_sealing",
        chargeId: null,
        attempt: 1,
        canResend: false,
      };

      // A sealed blob is opaque, so there is nothing to ask the customer for: the caller has to
      // re-seal with the PIN. Say that plainly instead of prompting for a code that cannot be used.
      if (card.sealed) {
        const err = new Error(
          "payCard: this issuer wants the PIN inside the sealed card, but the card arrived already " +
            "sealed. Seal it with the PIN (browser: sealCard(pem, card, pin)) and pass that blob, " +
            "or pass cardOptions.pin to confirm the blob already contains it."
        );
        err.code = "PIN_REQUIRED";
        err.step = challenge;
        throw err;
      }

      const answer = await onVerification?.(challenge);
      pin = typeof answer === "string" ? answer : answer?.pin ?? null;

      if (!pin) {
        const err = new Error(
          "This issuer wants the card PIN inside the sealed payload, before the charge exists. " +
            "Pass cardOptions.pin, or answer the collect_pin challenge from onVerification."
        );
        err.code = "PIN_REQUIRED";
        err.step = challenge;
        throw err;
      }
    }

    const handle = card.sealed
      ? (await vault.tokenizeSealed(card.sealed, { grant: grant.grant, collectPin: grant.collectPin })).handle
      : (await vault.tokenize(pin ? { ...card, pin } : card, { grant: grant.grant, collectPin: grant.collectPin })).handle;

    const first = await vault.complete({
      handle,
      quoteId: quote.quote_id,
      deviceInformation: cardOptions?.deviceInformation,
    });

    const driven = await driveCardVerification({
      vault,
      result: first,
      onVerification,
      onStep,
      maxAttempts: maxVerificationAttempts,
      chargeId: first?.charge_id ?? null,
    });

    // The verification response is authoritative: it may clear `next_action` / `auth_model`, so
    // only carry over identifying fields from the first charge, never challenge state.
    const merged = {
      ...driven.result,
      charge_id: driven.result?.charge_id || first?.charge_id || null,
      transaction_id: driven.result?.transaction_id || first?.transaction_id || null,
      payment_type: driven.result?.payment_type || first?.payment_type,
      amount: driven.result?.amount ?? first?.amount ?? null,
      currency: driven.result?.currency ?? first?.currency,
    };
    const step = nextCardStep(merged);
    const payment = normalise(merged, rail, quote);

    let final = null;
    if (waitForResult && payment.chargeId && (step.action === "poll" || step.action === "done")) {
      final = await this.waitForPayment(payment.chargeId, waitOptions);
    }

    return {
      ...payment,
      step,
      verificationAttempts: driven.attempts,
      ...(driven.reason ? { verificationReason: driven.reason } : {}),
      ...(final ? { final } : {}),
    };
  }

  /**
   * Answer an OTP challenge manually (when you render your own screen instead of using payCard).
   * Returns the next step plus the raw response.
   */
  async submitOtp({ chargeId, otp, resend = false }) {
    const raw = await this.#vault().authorizeOtp({ chargeId, otp, resend });
    return { step: nextCardStep(raw, { chargeId }), raw };
  }

  /** Answer an AVS challenge manually. */
  async submitAvs({ chargeId, address }) {
    const raw = await this.#vault().submitAvs({ chargeId, address });
    return { step: nextCardStep(raw, { chargeId }), raw };
  }

  /** Submit a card PIN when the issuer asks for one after the charge. */
  async submitPin({ chargeId, pin }) {
    const raw = await this.#vault().authorizePin({ chargeId, pin });
    return { step: nextCardStep(raw, { chargeId }), raw };
  }

  /** Just the next step for a charge response (no request). */
  cardStep(result, { chargeId } = {}) {
    return nextCardStep(result, { chargeId });
  }

  /** Poll a charge until it reaches a terminal state. */
  async waitForPayment(chargeId, { timeoutMs = 120000, intervalMs = 2500, onTick } = {}) {
    const terminal = new Set([
      "paid", "succeeded", "overpaid", "underpaid", "failed", "canceled", "cancelled", "expired", "refunded",
    ]);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.chargeStatus(chargeId);
      onTick?.(last);
      if (terminal.has(String(last?.charge_status || "").toLowerCase())) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
  }
}

/* ----------------------------------------------------- normalised outputs */

/**
 * @typedef {object} NormalisedPayment
 * @property {"bank_transfer"|"crypto"|"mobile_money"|"card"|"redirect"} type
 * @property {string} method
 * @property {string} kind
 * @property {string|null} chargeId
 * @property {string|null} transactionId
 * @property {string|null} amount decimal string, never a float
 * @property {string} currency
 * @property {string|null} quoteId
 * @property {string|null} expiresAt
 * @property {string|null} status provider's payment_type
 * @property {boolean} pollingRequired
 * @property {object|null} instructions
 * @property {any} raw the provider's untouched response
 */

/**
 * Turn a `/complete` response into a discriminated union your UI can switch on.
 * Every field is derived from the response; `raw` holds the original.
 *
 * @returns {NormalisedPayment}
 */
export function normalise(result, rail, quote) {
  const base = {
    method: rail.paymentMethod,
    kind: rail.kind,
    chargeId: result.charge_id || null,
    transactionId: result.transaction_id || null,
    amount: result.amount ?? quote?.total_amount ?? null,
    currency: result.currency ?? rail.currency,
    quoteId: quote?.quote_id ?? null,
    expiresAt: result.expires_at ?? result.instructions?.expires_at ?? null,
    status: result.payment_type || null,
    pollingRequired: result.polling_required === true,
    raw: result,
  };

  const i = result.instructions;

  if (i && rail.kind === "bank_transfer") {
    return {
      ...base,
      type: "bank_transfer",
      instructions: {
        accountNumber: i.account_number ?? null,
        accountName: i.account_name ?? null,
        bankName: i.bank_name ?? null,
        bankCode: i.bank_code ?? null,
        amountExpected: i.amount_expected ?? null,
        reference: i.payment_reference ?? i.reference ?? null,
        expiresAt: i.expires_at ?? null,
        fee: i.fee ?? null,
        vat: i.vat ?? null,
      },
    };
  }

  if (i && rail.kind === "crypto") {
    return {
      ...base,
      type: "crypto",
      instructions: {
        address: i.address ?? null,
        network: i.network ?? null,
        currency: i.currency ?? null,
        amount: i.amount ?? null,
        qrCode: i.qr_code ?? null, // data:image/png;base64,...
        expiresAt: i.expires_at ?? null,
        expiresInMinutes: i.expires_in_minutes ?? null,
      },
    };
  }

  if (i && rail.kind === "mobile_money") {
    return {
      ...base,
      type: "mobile_money",
      instructions: {
        action: i.action ?? null, // e.g. "approve_on_phone"
        message: i.message ?? null,
      },
    };
  }

  const paymentType = String(result.payment_type || "").toLowerCase();
  const redirectUrl = result.payment_url || result.next_action?.redirect_url || result.next_action?.redirect_to_url?.url;

  if (paymentType === "redirect" && redirectUrl) {
    return {
      ...base,
      type: "redirect",
      url: redirectUrl,
      gatewaySessionId: result.gateway_session_id ?? null,
      nextAction: result.next_action ?? null,
    };
  }

  return {
    ...base,
    type: "card",
    clientSecret: result.client_secret ?? null,
    nextAction: result.next_action ?? null,
    authModel: result.auth_model ?? null,
    gatewaySessionId: result.gateway_session_id ?? null,
  };
}

export { CardVault, KNOWN_CARD_ACTIONS };
export { cardChallenge, nextCardStep, driveCardVerification, AVS_FIELDS };
export default Bachs;
