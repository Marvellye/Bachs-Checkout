# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
