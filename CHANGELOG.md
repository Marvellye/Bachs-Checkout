# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.5

### Fixed

- A verification answer could be swallowed. When a challenge response omitted `charge_id`,
  `driveCardVerification` prompted the customer, received the code, then returned quietly without
  submitting it. It now falls back to the charge id from `/complete`, and if there is still no
  target it throws `VERIFICATION_NO_CHARGE_ID` with the step attached instead of silently waiting.

### Added

- `onStep({ step, response })` fires after every verification call with the raw API response, so a
  rejected OTP can be diagnosed instead of guessed at. `driveCardVerification` accepts
  `chargeId` as an explicit fallback target.

## 0.2.4

### Fixed

- Documented cards could not be charged on live at all. The checkout build asks for the card PIN
  **before** the card is sealed, by answering `collect_pin: true` on `mintTokenizeGrant`, and
  expects it inside the encrypted payload. `payCard()` ignored that flag, sealed without a PIN, and
  completed into a charge the issuer would never authorise. This is the normal path for Nigerian
  issuers; live answers `collect_pin: true` for both NGN and USD sessions.

### Added

- `CardVault#mintGrant()` returns `{ grant, collectPin }` so a UI can ask for the PIN before
  sealing, which is what the hosted checkout does.
- `payCard({ card, cardOptions: { pin } })` puts the PIN inside the seal, and `onVerification`
  receives a `collect_pin` challenge with `phase: "before_sealing"` when none was supplied. If a
  caller passes an already-sealed blob while the build wants a PIN, it throws `PIN_REQUIRED` with
  the step attached rather than sending a charge that cannot succeed.
- `tokenizeSealed(sealed, { grant, collectPin })` reuses a grant instead of minting a second one.

## 0.2.3

### Fixed

- Live card charges failed with `ACTION_STALE` on the first vault call. The card-vault server-action
  ids are per checkout build, and all six differ between sandbox and live, so the sandbox constants
  baked into `KNOWN_CARD_ACTIONS` were useless on a live session. Discovery is now part of the
  package instead of a script you had to remember to run.

### Added

- `discoverCardActions(checkoutOrigin, token)` crawls the public checkout bundle for the six ids.
- `CheckoutSession#refreshCardActions()` resolves them for the session's own build and stores them,
  so the next `payCard()` uses the right ones.
- `parseActionIds()` and `parseChunkRefs()` are exported as pure functions, so ports and tests can
  reuse the parsing without the network.
- `scripts/discover-actions.mjs` is now a thin CLI wrapper over the packaged implementation.

## 0.2.2

### Fixed

- The shipped `index.d.ts` did not know about `CheckoutSession#environment` or the `environment`
  option added in 0.2.1, so TypeScript users had to cast to reach it. Types and code now agree.

### Added

- `npm run typecheck` compiles `tests/public-api.ts` under `--strict`. Every export and option the
  README documents is exercised there, so a type can no longer drift from the implementation. It
  runs in CI on every Node version and blocks `npm publish`.

## 0.2.1

### Fixed

- `CheckoutSession` no longer assumes sandbox. A session built from a live key used to default
  `apiBase` to `sandbox-api.bachs.io`, so every `/v1/public/checkouts/{token}` call answered
  `UNAUTHORIZED: Invalid or expired checkout token` even though the token was valid. Pass
  `environment: "live"`, or an `apiBase`, and the checkout origin follows it.
- `CheckoutSession.fromUrl` now also reports `environment`, and is the recommended way to build a
  session — the URL already knows which side it came from.

### Added

- `CheckoutSession#environment` — `"live"` or `"sandbox"`, so a UI can say which one it is on.

## [0.2.0] - 2026-10-26

Card verification is now a first-class, server-guided flow instead of a documented gap.

### Added

- `nextCardStep(response)` — a pure, total mapping from the API's `next_action` to an action your UI
  switches on: `collect_otp`, `collect_pin`, `collect_avs`, `redirect`, `confirm_inline`, `poll`,
  `done`.
- `cardChallenge(response)` and `AVS_FIELDS` for rendering the specific prompt.
- `driveCardVerification({ vault, result, onVerification, maxAttempts })` — runs the challenge loop,
  asking your callback for each answer, with a hard attempt ceiling.
- `CheckoutSession.payCard({ card, onVerification, waitForResult })` — charge + verification + poll in
  one call, returning the normalised payment with `step`, `verificationAttempts`, `final`.
- Manual steps for custom screens: `submitOtp({ chargeId, otp | resend })`,
  `submitAvs({ chargeId, address })`, `submitPin({ chargeId, pin })`, and the pure `cardStep()`.
- `CardVault.authorizeOtp`, `submitAvs`, `authorizePin` with the exact payloads the checkout build
  sends: `{ charge_id, type: "otp", otp }`, `type: "resend_otp"`, `type: "avs"`.
- 27 new unit tests covering every verification branch, including a wrong OTP that must re-prompt
  rather than fail the payment.
- The example UI renders the guided steps: OTP entry with resend, address form, issuer redirect.

### Fixed

- A verification response could inherit a stale `auth_model: "OTP"` from the original charge, which
  made a completed verification look like it still needed a code. Challenge state now comes only from
  the latest response.

### Changed

- Licence is now WTFPL.
- `npm test` runs both suites (`tests/unit.test.js`, `tests/card-verification.test.js`).

### Known limitations

- Sandbox cards auto-approve, so the OTP/AVS round trip has not been observed against a live issuer.
- `authorizePinViaVault`'s argument order is inferred from the checkout build, not observed.

## [0.1.0] - 2026-10-26

First public release.

### Added

- `Bachs` client for the private API: checkout sessions, products, payments, refunds, customers,
  subscriptions, webhooks, balances, account.
- `CheckoutSession` client for the token-scoped public checkout API: `detail`, `requirements`,
  `quote`, `complete`, `setAmount`, `chargeStatus`, `authorizeMobileMoney`, `confirmPayment`,
  `pay`, `waitForPayment`.
- `pay()` returns a discriminated union — `bank_transfer`, `crypto`, `mobile_money`, `card`,
  `redirect` — with the provider's untouched response under `raw`.
- All five session creation shapes: catalog cart, raw amount (`pricing`), buyer-chosen (`custom`),
  `free`, and per-line price override.
- `CardVault` with RSA-OAEP-256 + AES-256-GCM sealing: `tokenize`, `tokenizeSealed`, `complete`,
  `authorizeOtp`, `authorizePin`.
- `bachs-checkout/browser`: `sealCard`, `mountCardForm`, `deviceInformation`, `nextActionUrl`.
- Webhook verification: `Bachs.verifyWebhook` and `Bachs.constructEvent`
  (`X-Bachs-Signature-V2`, timestamp tolerance, rotation-aware).
- TypeScript declarations for both entry points.
- 31 unit tests (no network) and an integration suite covering every rail and both card outcomes.
- Postman collection generated from the official OpenAPI spec: 129 requests, 25 folders, with real
  sandbox responses as examples.
- `examples/server.mjs` + `examples/public/index.html`: a working custom checkout UI for all four
  rails, with the browser/server card split.
- `scripts/live-check.mjs`: read-only-by-default live credential check with a USD-equivalent burn cap,
  confirmation prompt and environment detection from the key prefix.
- `scripts/discover-actions.mjs`: resolves the card vault's server-action ids from any checkout build.

### Known limitations

- 3DS/OTP (`next_action.type === "requires_otp"`) is implemented but unverified: sandbox cards
  auto-approve.
- The public checkout API and card vault are undocumented and may change without notice.
