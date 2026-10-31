# bachs-checkout

**Unofficial SDK for [Bachs](https://bachs.io) that lets you take payments in your own UI — cards, bank transfer, crypto and mobile money — without redirecting anyone to a hosted checkout.**

[![npm](https://img.shields.io/npm/v/bachs-checkout.svg)](https://www.npmjs.com/package/bachs-checkout)
[![tests](https://github.com/Marvellye/Bachs-Checkout/actions/workflows/ci.yml/badge.svg)](https://github.com/Marvellye/Bachs-Checkout/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-WTFPL-blue.svg)](./LICENSE)

The hosted checkout is a fine default. This is for when it isn't: when you need the payment step
inside your own product, when the account numbers and wallet addresses must render in your layout,
or when a redirect would lose the customer.

It returns **raw JSON** for every rail, normalised into a discriminated union, with the provider's
untouched response kept under `raw`.

```bash
npm install bachs-checkout
```

> **Unofficial.** Not affiliated with or endorsed by Bachs. It is built on Bachs' public API plus the
> same endpoints Bachs' own checkout page calls. Read [Caveats](#caveats) before shipping.

---

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [The rails](#the-rails)
- [Session shapes](#session-shapes)
- [Card payments](#card-payments)
- [Card verification (OTP, PIN, AVS, 3DS)](#card-verification-otp-pin-avs-3ds)
- [Webhooks](#webhooks)
- [Testing](#testing)
- [Postman](#postman)
- [API reference](#api-reference)
- [Caveats](#caveats)
- [SDK contract](./docs/SDK-CONTRACT.md) for ports to PHP, Python or anything else
- [Contributing](#contributing)

---

## Why this exists

Bachs documents one surface: the private API your server calls to create a checkout session. But a
session is just a URL, and paying on that URL means leaving your app.

The checkout page itself is a client of a second, undocumented surface — token-scoped endpoints under
`/v1/public/checkouts/{token}/` that price a rail, complete it, and return the instructions to
render. That token is the only credential those calls need, so **your browser can drive a checkout
without ever seeing your secret key**. This SDK wraps both surfaces, plus the card vault.

| Surface | Auth | What it gives you |
| --- | --- | --- |
| `/v1/...` | `sk_sandbox_…` / `sk_live_…` | sessions, products, payments, refunds, webhooks |
| `/v1/public/checkouts/{token}/...` | checkout token, **no key** | detail, requirements, quote, complete, charge status |
| Card vault | RSA-sealed payload | tokenize and charge card data directly |

The checkout app is a white-label Whop build and card charges settle through Flutterwave
(`transaction_id: flw_tx_…`).

---

## Quick start

### 1. Server: create the payment request

The amount is fixed server-side, so the browser cannot change what the customer pays.

```js
import { Bachs } from "bachs-checkout";

const bachs = new Bachs({ secretKey: process.env.BACHS_SECRET_KEY });

const session = await bachs.checkoutSessions.create({
  product_cart: [{ product_id: "prod_abc123", quantity: 1 }],
  customer: { email: "customer@example.com" },
  success_url: "https://yoursite.com/thanks",
  cancel_url: "https://yoursite.com/cart",
  reference: "ORDER-1042",
});

// Send session.checkout_url's token to your frontend. Never send the secret key.
```

No product in mind? Skip the catalog entirely:

```js
const session = await bachs.checkoutSessions.createRaw({
  amount: "42.00",
  currency: "USD",
  customer: { email: "customer@example.com" },
});
```

### 2. Pay a rail

`CheckoutSession` only needs the token, so it runs happily in the browser:

```js
import { CheckoutSession } from "bachs-checkout";

const checkout = CheckoutSession.fromUrl(session.checkout_url);

const payment = await checkout.pay({ rail: "bank" });

console.log(payment.type);         // "bank_transfer"
console.log(payment.instructions); // { accountNumber, accountName, bankName, reference, ... }
console.log(payment.raw);          // Bachs' exact response, untouched
```

### 3. Render it

```js
switch (payment.type) {
  case "bank_transfer":
    show(`Transfer ${payment.amount} ${payment.currency} to
          ${payment.instructions.accountNumber} (${payment.instructions.bankName})`);
    break;
  case "crypto":
    showAddress(payment.instructions.address);
    showQr(payment.instructions.qrCode);            // data:image/png;base64,...
    startCountdown(payment.instructions.expiresInMinutes);
    break;
  case "mobile_money":
    prompt(`Approve the prompt on your phone: ${payment.instructions.message}`);
    break;
  case "card":
    finaliseCardPayment(payment);                    // chargeId + status
    break;
  case "redirect":
    location.assign(payment.url);                    // only free/processor rails
    break;
}
```

### 4. Confirm

```js
const final = await checkout.waitForPayment(payment.chargeId);
// { charge_status: "succeeded", amount_paid: "1423.55", amount_remaining: "0.00", ... }
```

Polling is a convenience. In production, fulfil on the [webhook](#webhooks).

### Runnable example

```bash
BACHS_SECRET_KEY=sk_sandbox_... npm run example
# http://localhost:4242 — a custom checkout with all four rails
```

`examples/server.mjs` is ~150 lines and shows the whole loop, including the browser/server split for
cards.

---

## The rails

| Rail | `pay({ rail })` | Returns | Poll to |
| --- | --- | --- | --- |
| Bank transfer | `"bank"` | `instructions`: `accountNumber`, `accountName`, `bankName`, `bankCode`, `amountExpected`, `reference`, `expiresAt` | `succeeded` |
| Crypto | `"crypto"` + `currency: "USDT_TRC20"` | `instructions`: `address`, `network`, `amount`, `qrCode`, `expiresInMinutes` | `succeeded` |
| Mobile money | `"momo_ghs"` + `phone` + `paymentRail` | `instructions`: `action: "approve_on_phone"`, `message` | `succeeded` |
| Card (USD) | `"card"` + `card` | `type: "card"`, `chargeId`, or `clientSecret` for the inline rail | `succeeded` / `failed` |
| Card (NGN) | `"card"`, `currency: "NGN"` | `type: "card"`, `chargeId` | `awaiting_approval` → `succeeded` |
| Free | `"free"` | `type: "redirect"`, `url` | completes immediately |

Corridors and currencies available on your account:

```js
const detail = await checkout.detail();
detail.payment_methods;
// [{ payment_method: "NGN_BANK_TRANSFER", label: "Bank Transfer", currencies: ["NGN"] },
//  { payment_method: "CRYPTO", label: "Cryptocurrency", currencies: ["USDT_TRC20", ...] }, ...]
```

### Mobile money needs two steps

The network is a dynamic requirement, not a guess:

```js
const req = await checkout.requirements({ paymentMethod: "MOMO_GHS", currency: "GHS" });
const network = req.fields.find((f) => f.id === "payment_rail").options[0].value; // "mtn"

await checkout.pay({ rail: "momo_ghs", phone: "+233201234567", paymentRail: network });
```

Phone must be `+countrycode…` or 7–10 local digits. A bare country code without `+` is rejected.

### A decline is a state, not an exception

A refused card leaves the session **open** so the customer can retry:

```js
const final = await checkout.waitForPayment(payment.chargeId);
if (final.attempt_failed) {
  // final.failure_code    -> "bank_declined"
  // final.failure_message -> "The payment was declined. Try again..."
  // session is still usable: quote again and retry with another card
}
```

---

## Session shapes

`product_cart` and `pricing` are mutually exclusive, and the SDK rejects both together before any
request leaves your process.

| Shape | Call | Notes |
| --- | --- | --- |
| Catalog | `create({ product_cart })` | `session_mode: "CART"` |
| Raw amount | `createRaw({ amount, currency })` | `products: null`, no catalog |
| Buyer-chosen | `createCustom({ currency, presetAmount, minimumAmount, maximumAmount })` | change it later with `checkout.setAmount("7.50")` |
| Free | `createFree({ currency })` | `amount: "0.00"`, `payment_required: false` |
| Price override | `create({ product_cart: [{ product_id, pricing: { price_type: "fixed", amount: "19.00" } }] })` | one session only; catalog untouched |

Minimums are per currency and enforced by the API: **NGN 100.00**, **USD 1.00**. The SDK exports
`MIN_AMOUNT` so your form can validate before the round trip.

---

## Card payments

`POST /v1/charges` exists but only charges a card **already saved** at a previous checkout. There is
no "send us a PAN" endpoint, in any gateway. Bachs' checkout solves this by sealing card data in the
page with its vault's public RSA key and posting the ciphertext to its own server actions. This SDK
does the same thing.

### Server-side (simplest)

```js
const payment = await checkout.pay({
  rail: "card",
  currency: "USD",
  card: { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" },
});
```

The PAN is AES-256-GCM encrypted with a fresh key, and that key is wrapped with RSA-OAEP-256 before
it leaves the process. Only the seal is transmitted.

### Browser → your server (recommended for real products)

```js
import { sealCard, deviceInformation } from "bachs-checkout/browser";

const pem = await fetch(`${checkoutOrigin}/api/vault/public-key`).then((r) => r.json()).then((j) => j.public_key_pem);
const sealed = await sealCard(pem, {
  card_number: "4242424242424242",
  expiry_month: 9,
  expiry_year: 2033,
  cvv: "431",
});

await fetch("/api/pay/card", {
  method: "POST",
  body: JSON.stringify({ token, sealed, device: deviceInformation() }),
});
```

```js
// your server — ciphertext in, never a PAN
const vault = new CardVault({ token, checkoutOrigin });
const { handle } = await vault.tokenizeSealed(req.body.sealed);
const result = await vault.complete({ handle, quoteId, deviceInformation: req.body.device });
```

### The action ids are per build

The vault's server-action ids belong to whichever checkout build is deployed. All six differ between
sandbox and live, and a redeploy can rotate them, so resolve them rather than trusting constants:

```js
const checkout = CheckoutSession.fromUrl(session.checkout_url);
const { ids, crawled, missing } = await checkout.refreshCardActions();
// 6/6 resolved from 16 chunks on a live session, ~2s
```

Or from the shell:

```bash
node scripts/discover-actions.mjs https://checkout.bachs.io <checkout-token>
```

The resolved ids live on the session, so the next `payCard()` uses them. `new CheckoutSession(token,
{ cardActionIds })` and `new CardVault({ token, actionIds })` still accept them by hand.

If a build moves underneath you mid-flight, the vault throws `err.code === "ACTION_STALE"` instead of
a mystery 404: call `refreshCardActions()` again and retry once. A sandbox session can keep using the
bundled constants; a live session cannot, because none of them match.

### If the rail is `inline` instead

Some accounts/currencies return `payment_type: "inline"` with a Stripe PaymentIntent `client_secret`.
Confirm it in your own form with Stripe.js Elements. Stripe refuses raw card data with a publishable
key (`unsupported for publishable key tokenization`), so Elements is the only supported shape there —
there is no server-side shortcut.

---

## Card verification (OTP, PIN, AVS, 3DS)

A card charge is not "charge and done". The issuer can come back asking for an OTP, a card PIN, an
address, or a hop to their own page — and after each answer it may ask for something else. The API
says what it wants in `next_action`, so this SDK does not guess: it turns that into an explicit step
your UI switches on.

```js
const step = nextCardStep(completeResponse);

switch (step.action) {
  case "collect_otp":     showOtpScreen(step.chargeId, step.canResend); break;
  case "collect_pin":     showPinScreen(step.chargeId); break;
  case "collect_avs":     showAddressForm(step.chargeId, step.fields); break;
  case "redirect":        location.assign(step.url); break;
  case "confirm_inline":  confirmWithStripeElements(step.clientSecret); break;
  case "poll":            watch(step.chargeId); break;
  case "done":            celebrate(); break;
}
```

### Let the SDK drive it

```js
const payment = await checkout.payCard({
  card: { card_number: "4242424242424242", expiry_month: 9, expiry_year: 2033, cvv: "431" },
  currency: "USD",
  onVerification: async ({ action, attempt, canResend }) => {
    if (action === "collect_otp") return { otp: await promptForCode({ attempt, canResend }) };
    if (action === "collect_avs") return { address: await promptForAddress() };
    return null;                       // give me the step back and I'll render it myself
  },
  waitForResult: true,
});

payment.type;                  // "card"
payment.step.action;           // "poll" | "collect_otp" | "redirect" | ...
payment.verificationAttempts;  // how many challenges were answered
payment.final?.charge_status;  // "succeeded" when waitForResult was set
```

`onVerification` is called once per challenge growing `attempt` from 1. Returning `null` stops the
loop and hands you `payment.step` — nothing is submitted behind your back.

### Drive it yourself

```js
const { step, raw } = await checkout.submitOtp({ chargeId, otp: "123456" });

if (step.action === "collect_otp") {
  showError("That code didn't work", { canResend: step.canResend });
}

await checkout.submitOtp({ chargeId, resend: true });        // re-issue the code
await checkout.submitAvs({ chargeId, address: { line1, city, state, postal_code } });
await checkout.submitPin({ chargeId, pin: "1234" });         // only when step.action === "collect_pin"
```

### What the wire actually looks like

| Challenge | Request sent to the checkout's `authorizeCardStep` |
| --- | --- |
| OTP | `{ charge_id, type: "otp", otp }` |
| Resend | `{ charge_id, type: "resend_otp" }` |
| Address | `{ charge_id, type: "avs", address: { line1, city, state, postal_code, country } }` |
| PIN | `authorizePinViaVault(chargeId, pin)` — no token argument, unlike the others |

A **wrong OTP is not an error**. It returns `status: "failed"` *with* `next_action.type` still
`requires_otp`, which is why `nextCardStep` maps it back to `collect_otp` — the screen stays open and
the customer retries. Anything else turns a retryable typo into a dead payment.

Guards: `maxVerificationAttempts` (default 3) stops a loop from becoming infinite, and
`driveCardVerification` refuses to submit an answer the caller did not provide.

### Test coverage

`tests/card-verification.test.js` covers every branch with captured shapes: OTP, resend, wrong code,
AVS, PIN, redirect, inline, plain poll, junk input, and the full loop with a scripted vault.

---

## Webhooks

Verify against the **raw** body, before `JSON.parse`, then dedupe by event id.

```js
import { Bachs } from "bachs-checkout";

export async function POST(req) {
  const raw = await req.text();                              // raw, not parsed
  const event = Bachs.constructEvent(
    raw,
    req.headers.get("x-bachs-signature-v2"),
    process.env.BACHS_WEBHOOK_SECRET
  );

  switch (event.type) {
    case "collection.succeeded":
    case "checkout.completed":
      await fulfil(event.data);                              // idempotent
      break;
  }
  return new Response("ok");
}
```

`npm run verify:pack` is the release gate: it packs the tarball, installs it into a temp directory and
imports `bachs-checkout` plus `bachs-checkout/browser`, so a file missing from `files` or a broken
`exports` map fails before publishing instead of after.

`X-Bachs-Signature-V2` looks like `t=<unix>,v1=<hex>[,v1=<hex>]`: an HMAC-SHA256 over
`"${timestamp}.${rawBody}"`, 300-second tolerance, multiple `v1` values while a secret is rotating.
`Bachs.verifyWebhook(...)` handles all of it.

Endpoints auto-disable after consecutive delivery failures. Check `enabled` / `disabled_reason`
before assuming your handler is at fault.

---

## Testing

```bash
npm test                 # 62 unit tests, no network, no credentials
npm run typecheck        # the .d.ts, compiled under --strict
npm run test:integration # real sandbox charges (needs BACHS_SECRET_KEY)
npm run verify:pack      # pack, install clean, import every entry point
```

The integration suite covers every rail and both card outcomes, and refuses to run with a `sk_live_`
key. Test credentials:

| Card | Result |
| --- | --- |
| `4242 4242 4242 4242` | success |
| `4000 0000 0000 0002` | declined |
| `4000 0000 0000 9995` | insufficient funds |
| `4000 0000 0000 0069` | expired card |
| `4000 0000 0000 0119` | processing error |

Expiry `09/33`, any CVV — these are published by Bachs on the sandbox checkout page.

### Live credentials

`scripts/live-check.mjs` is read-only by default: it verifies the key, the account, the enabled
rails, the webhook config and the vault key, and creates nothing.

```bash
cp postman/Bachs-Live.postman_environment.example.json .env.live   # add your sk_live_ key
node scripts/live-check.mjs --env-file .env.live                   # preflight only

node scripts/live-check.mjs --pay --method bank  --amount 100 --currency NGN --env-file .env.live
node scripts/live-check.mjs --pay --method card  --amount 1.00 --currency USD --card-file .card.json
```

Guard rails: a USD-equivalent burn cap (`--max-usd`, default $2 live), a `CHARGE` confirmation prompt,
`--card-file` so a PAN never lands in shell history, and environment detection from the key prefix — a
live key never silently falls back to sandbox.

---

## Postman

```bash
python3 tools/build-postman.py --fetch   # spec + collection + environments
```

**129 requests across 25 folders**:

- **SDK Flow: create the payment** — product, session, and every creation shape
- **Custom UI: drive the checkout (public API)** — detail → set-amount → requirements → quote →
  complete per rail → charge status, with real captured responses as examples
- **Card vault (direct card data)** — vault key, grant, tokenize, complete, OTP, PIN
- **The full documented API surface**, generated from the official OpenAPI spec

Collection-level pre-request script attaches `Idempotency-Key` to every write; test scripts capture
ids so requests chain top to bottom.

```bash
npm run postman:smoke         # catalog flow
npm run postman:smoke adhoc   # product-less amount
npm run postman:smoke custom  # buyer-chosen amount
```

---

## API reference

### `new Bachs({ secretKey, baseUrl?, timeoutMs? })`

`baseUrl` defaults from the key prefix (`sk_live_` → `api.bachs.io`, otherwise sandbox).

| Member | Methods |
| --- | --- |
| `checkoutSessions` | `create`, `createRaw`, `createCustom`, `createFree`, `get` |
| `products` | `create`, `get`, `list`, `update`, `archive`, `unarchive` |
| `payments` | `get`, `list`, `charge` |
| `refunds` | `create`, `get`, `list`, `byPayment` |
| `customers` | `create`, `get`, `list`, `update`, `portalSession` |
| `subscriptions` | `get`, `list`, `update`, `cancel` |
| `webhooks` | `create`, `list`, `update`, `remove`, `rotateSecret`, `events`, `replay` |
| `balances` | `get`, `settings` |
| `account` | `me`, `paymentMethods`, `paymentRails`, `currencies`, `payoutCurrencies` |
| — | `request(path, opts)` for anything unwrapped |

Static: `verifyWebhook`, `constructEvent`. Helpers: `isUncertainWrite(err)`.

### `new CheckoutSession(token, { apiBase?, checkoutOrigin?, environment?, cardActionIds? })`

No secret key required. `CheckoutSession.fromUrl(checkoutUrl)` derives everything, including
sandbox vs live. If you build one from a bare token, pass `environment: "live"` (or an `apiBase`):
the default is sandbox, and a live token redeemed on the sandbox API answers
`UNAUTHORIZED: Invalid or expired checkout token`.

`detail()`, `requirements()`, `quote()`, `complete()`, `setAmount()`, `chargeStatus()`,
`authorizeMobileMoney()`, `confirmPayment()`, `pay()`, `waitForPayment()`.

### `new CardVault({ token, checkoutOrigin?, actionIds? })`

`publicKey()`, `tokenize(card)`, `tokenizeSealed(sealed)`, `complete({ handle, quoteId })`,
`authorizeOtp()`, `submitAvs()`, `authorizePin()`. Static `seal(pem, card, pin?)`.

### Errors

Everything throws `BachsError` with `status`, `code` (`error_code`), `detail` and the parsed `body`.
On a timeout or 5xx, `isUncertainWrite(err)` is `true` — reconcile by listing before retrying.

---

## Caveats

Read these; each one cost real time.

1. **The public checkout API and the card vault are undocumented.** Bachs can change them without a
   deprecation notice. The vault's action ids are per build. Pin your dependency version and re-run
   `scripts/discover-actions.mjs` after a Bachs deploy.
2. **No plaintext card data, ever.** Sealing keeps it out of your storage, but you are still handling
   card data in a custom form. Check your PCI obligations (SAQ-A vs SAQ-D) before going live; the
   hosted checkout is the lower-scope option.
3. **3DS / OTP is guided and fixture-tested, but no live issuer has demanded it yet.** The flow is
   driven entirely by `next_action` and every branch is covered by tests, but sandbox cards
   auto-approve, so the OTP/AVS round trip has never completed against a real bank. The PIN action's
   argument order is inferred from the checkout build rather than observed. Charge a real card that
   demands 3DS before you rely on it.
4. **`products` is `null`, not `[]`**, on product-less sessions. `products.length` throws.
5. **`localhost` is rejected** for `success_url` / `cancel_url` ("must be a publicly accessible URL").
   Irrelevant for a no-redirect UI — nothing navigates there — but fatal for the hosted rail.
6. **Live bank instructions are sparser than sandbox.** On a live charge, `bankCode`,
   `amountExpected`, `reference` and `expiresAt` can all come back `null`; sandbox populates them.
   Render conditionally, and show the amount from the quote, not from the instruction object.
7. **A bank transfer does not settle by itself.** Sandbox credits instantly; production waits for the
   customer's transfer. `waitForPayment` returning `open` is correct, not a failure.
8. **`payment_method_types` is enforced later.** Restricting a session to cards is accepted at
   creation and fails a bank quote much later with `PAYMENT_METHOD_NOT_ALLOWED`.
9. **Free and processor rails return `payment_type: "redirect"`** with a URL — handle the branch or
   the flow dead-ends.
10. **Money is always a decimal string.** `"1423.410000000000000000"` is normal. Round for display,
    never for arithmetic — use a decimal library.
11. **Quotes expire in minutes.** Re-quote; never replay a stale `quote_id`.
12. **Idempotency is not optional.** The SDK generates a key per write. On an uncertain failure,
    reconcile before retrying, or you risk a double charge.

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Please never paste live keys,
webhook secrets or real card data into an issue.

If this saved you time, [sponsor the work](https://github.com/sponsors/Marvellye).

## License

[WTFPL](./LICENSE) © Marvellous Ezekiel — do what the fuck you want to.

Bachs and the Bachs name are trademarks of their owners. This project is an independent, unofficial
client.
