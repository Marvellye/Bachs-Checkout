/**
 * Custom-UI example: a checkout page that never redirects.
 *
 *   BACHS_SECRET_KEY=sk_sandbox_... npm run example
 *   open http://localhost:4242
 *
 * Everything the page renders comes from the API: a bank account number, a crypto address with a
 * countdown, a mobile-money approval prompt, or a card charge. Card data is sealed in the browser
 * (see /browser.js) and only ciphertext reaches this server.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bachs, CheckoutSession, CardVault, SANDBOX_CHECKOUT } from "../src/index.js";
import { discoverActions } from "../scripts/discover-actions.mjs";

const PORT = Number(process.env.PORT || 4242);
const SECRET = process.env.BACHS_SECRET_KEY;
const ORIGIN = process.env.BACHS_CHECKOUT_ORIGIN || SANDBOX_CHECKOUT;

if (!SECRET) {
  console.error("Set BACHS_SECRET_KEY (sk_sandbox_...) before starting the example.");
  process.exit(1);
}

const bachs = new Bachs({ secretKey: SECRET });
const here = path.dirname(fileURLToPath(import.meta.url));

/** Server-action ids are per build; resolve once, then reuse. */
let actionIdsPromise = null;
async function actionIdsFor(token) {
  actionIdsPromise = actionIdsPromise || discoverActions(ORIGIN, token)
    .then(({ actions, missing }) => {
      if (missing.length) throw new Error(`could not resolve card actions: ${missing.join(", ")}`);
      return Object.fromEntries(Object.entries(actions).map(([k, v]) => [k, v.id]));
    });
  return actionIdsPromise;
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(here, "public", "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // The browser seals card data with this module; serve it from the package source.
    if (req.method === "GET" && url.pathname === "/browser.js") {
      const src = fs.readFileSync(path.join(here, "..", "src", "browser.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end(src);
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return json(res, 200, { checkoutOrigin: ORIGIN });
    }

    // 1. Create the payment request (secret key stays here, on the server).
    if (req.method === "POST" && url.pathname === "/api/session") {
      const { amount = "1.00", currency = "USD", email = "customer@example.com" } = await readBody(req);
      const session = await bachs.checkoutSessions.createRaw({
        amount: String(amount),
        currency,
        customer: { email, name: "Custom UI Demo" },
        // Bachs rejects localhost for these URLs ("must be a publicly accessible URL"), and a
        // no-redirect UI never navigates to them anyway. Override for a deployed demo.
        success_url: process.env.SUCCESS_URL || "https://example.com/paid",
        cancel_url: process.env.CANCEL_URL || "https://example.com/cancelled",
        reference: `DEMO-${Date.now()}`,
        metadata: { source: "example" },
      });
      const token = session.checkout_url.split("/").pop();
      return json(res, 200, { token, amount: session.amount, currency: session.currency, checkoutId: session.checkout_id });
    }

    // 2. Read the session: amount, rails, branding.
    const detailMatch = url.pathname.match(/^\/api\/checkout\/([^/]+)$/);
    if (req.method === "GET" && detailMatch) {
      const checkout = new CheckoutSession(detailMatch[1], { checkoutOrigin: ORIGIN });
      return json(res, 200, await checkout.detail());
    }

    // 3. Pay a non-card rail.
    if (req.method === "POST" && url.pathname === "/api/pay") {
      const { token, rail = "bank", currency, phone, paymentRail } = await readBody(req);
      const checkout = new CheckoutSession(token, { checkoutOrigin: ORIGIN });
      const payment = await checkout.pay({ rail, currency, phone, paymentRail });
      return json(res, 200, payment);
    }

    // 4. Card: the browser already sealed the payload, so we only relay ciphertext.
    if (req.method === "POST" && url.pathname === "/api/pay/card") {
      const { token, sealed, device } = await readBody(req);
      if (!token || !sealed?.ciphertext) return json(res, 400, { error: "token and sealed payload are required" });

      const checkout = new CheckoutSession(token, { checkoutOrigin: ORIGIN });
      const quote = await checkout.quote({ paymentMethod: "USD_CARD", currency: "USD" });

      const vault = new CardVault({ token, checkoutOrigin: ORIGIN, actionIds: await actionIdsFor(token) });
      const { handle, brand, last4 } = await vault.tokenizeSealed(sealed);
      const result = await vault.complete({ handle, quoteId: quote.quote_id, deviceInformation: device });

      // The step tells the page what to render next: OTP, AVS, redirect, or poll.
      return json(res, 200, {
        type: "card",
        brand,
        last4,
        chargeId: result.charge_id,
        paymentType: result.payment_type,
        step: checkout.cardStep(result),
        raw: result,
      });
    }

    // 4b. Answer the verification the bank asked for (OTP / address).
    if (req.method === "POST" && url.pathname === "/api/pay/card/otp") {
      const { token, chargeId, otp, resend } = await readBody(req);
      if (!token || !chargeId) return json(res, 400, { error: "token and chargeId are required" });
      const checkout = new CheckoutSession(token, {
        checkoutOrigin: ORIGIN,
        cardActionIds: await actionIdsFor(token),
      });
      const { step, raw } = await checkout.submitOtp({ chargeId, otp, resend: Boolean(resend) });
      return json(res, 200, { step, raw });
    }

    if (req.method === "POST" && url.pathname === "/api/pay/card/avs") {
      const { token, chargeId, address } = await readBody(req);
      if (!token || !chargeId) return json(res, 400, { error: "token and chargeId are required" });
      const checkout = new CheckoutSession(token, {
        checkoutOrigin: ORIGIN,
        cardActionIds: await actionIdsFor(token),
      });
      const { step, raw } = await checkout.submitAvs({ chargeId, address });
      return json(res, 200, { step, raw });
    }

    // 5. Poll a charge.
    const statusMatch = url.pathname.match(/^\/api\/status\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && statusMatch) {
      const checkout = new CheckoutSession(statusMatch[1], { checkoutOrigin: ORIGIN });
      return json(res, 200, await checkout.chargeStatus(statusMatch[2]));
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    const status = err?.status && err.status >= 400 ? err.status : 500;
    return json(res, status, { error: err.message, code: err.code || null, detail: err.detail || null });
  }
});

server.listen(PORT, () => {
  console.log(`custom checkout UI: http://localhost:${PORT}`);
  console.log(`api:                ${bachs.baseUrl}`);
  console.log(`checkout origin:    ${ORIGIN}`);
});
