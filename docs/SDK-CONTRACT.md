# SDK contract

What `bachs-checkout` (JavaScript) guarantees, written down so the PHP and Python ports can be
verified against it rather than against a memory of it. Anything the JS SDK exposes, the other two
expose under the same name, with the same arguments in the same order.

Derived from `src/index.js` at 0.2.2. When this file and the code disagree, the code is right and
this file is a bug.

## 1. Environments and authentication

Two surfaces, two kinds of credential.

| Surface | Credential | Where it may run |
| --- | --- | --- |
| `/v1/*` (products, payments, refunds, webhooks) | secret key `sk_...` | server only, never a browser |
| `/v1/public/checkouts/{token}/*` | the checkout token | anywhere, including a page |
| `{checkoutOrigin}/api/vault/public-key` and the vault actions | the checkout token | anywhere |

The key prefix selects the hosts, and nothing else should:

| Key | API | Checkout |
| --- | --- | --- |
| `sk_sandbox_...` | `https://sandbox-api.bachs.io` | `https://sandbox-checkout.bachs.io` |
| `sk_live_...` | `https://api.bachs.io` | `https://checkout.bachs.io` |
| anything else | sandbox | sandbox |

The two hosts must move together. A live token redeemed on the sandbox API answers
`UNAUTHORIZED: Invalid or expired checkout token`, which reads like an expired session and is not
one. That is the single most expensive bug this package has shipped.

## 2. Money

Amounts are decimal **strings**, often with 18 places (`"1423.410000000000000000"`). Never parse
them into a float for arithmetic. Format for display, and rely on the API for every calculation.

Floors per currency: `NGN 100.00`, `USD 1.00`, everything else `1.00`. See `MIN_AMOUNT`.

## 3. Private surface

`Bachs({ secretKey, baseUrl?, timeoutMs? })`. Resources and their methods:

| Resource | Methods |
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
| escape hatch | `request(path, opts)` |

Statics on the client: `verifyWebhook`, `constructEvent`. Helper: `isUncertainWrite(err)`.

## 4. Public surface

`CheckoutSession(token, { apiBase?, checkoutOrigin?, environment?, timeoutMs?, cardActionIds? })`
and `CheckoutSession.fromUrl(checkoutUrl)`. No secret key. `fromUrl` is preferred: the URL already
says which environment it came from, and it sets `token`, `environment`, `apiBase` and
`checkoutOrigin` together.

| Method | Endpoint |
| --- | --- |
| `detail()` | `GET /detail` |
| `requirements({paymentMethod, currency, paymentRail?})` | `POST /requirements` |
| `quote({paymentMethod, currency, paymentRail?})` | `POST /get-quote` |
| `complete({paymentMethod, quoteId, ...})` | `POST /complete` |
| `setAmount(amount)` | `POST /set-amount` |
| `chargeStatus(chargeId)` | `GET /charges/{chargeId}/status` |
| `authorizeMobileMoney(body)` | `POST /mobile-money/authorize` |
| `confirmPayment(body)` | `POST /confirm-payment` |
| `pay({rail, currency?, phone?, paymentRail?, ...})` | `quote` then `complete`, then `normalise` |
| `payCard({sealed, device, currency?})` | quote, seal, tokenize, complete, then verification |
| `submitOtp({chargeId, otp?, resend?})` | vault `authorizeCardStep` |
| `submitAvs({chargeId, address})` | vault `authorizeCardStep` |
| `submitPin({chargeId, pin})` | vault `authorizePinViaVault` |
| `cardStep(result, fallback?)` | pure, no network |
| `waitForPayment({chargeId, timeoutMs?, intervalMs?})` | polls `chargeStatus` |

Every write carries `Idempotency-Key: <uuid v4>`, generated per call.

Mobile money corridors are **currency** codes, not country codes: `MOMO_GHS`, `MOMO_KES`,
`MOMO_UGX`, `MOMO_TZS`, `MOMO_XAF`, `MOMO_XOF`, `MOMO_RWF`, `MOMO_MWK`, `MOMO_ZMW`. `NGN_BANK_TRANSFER`,
`CRYPTO`, `USD_CARD`, `NGN_CARD` complete the set. Live rejects anything else with
`This payment method is not enabled for this organization`, which is misleading: the account has
the rail, the string was wrong.

## 5. Normalised results

`normalise(complete, rail, quote)` turns each rail into one shape with a `type`:

| `type` | Carries |
| --- | --- |
| `bank_transfer` | `instructions.accountNumber`, `bankName`, `accountName`, `reference`, `expiresAt` (may be `null` on live) |
| `crypto` | `instructions.address`, `network`, `currency`, `qrCode` (base64), `expiresAt` |
| `mobile_money` | `instructions.message`, plus the charge id to poll |
| `card` | `brand`, `last4`, `step`, or an inline `clientSecret` |
| `redirect` | `url`; free and processor rails land here, so the branch must exist |

## 6. Card sealing

Browser or server, the payload is identical:

1. `GET {checkoutOrigin}/api/vault/public-key` returns `public_key_pem` (SPKI, RSA-OAEP-256).
2. Generate a 256-bit AES key. Encrypt the JSON card object with AES-256-GCM and a fresh 12-byte IV.
3. Wrap the AES key with RSA-OAEP-SHA256.
4. Send `{ encrypted_key, iv, ciphertext }`, base64, and nothing else.

PIN sealing wraps the PIN itself, and the field is `pin` rather than a card object.

Do not send a PAN to your own server. If a language cannot do RSA-OAEP-SHA256 and AES-256-GCM,
it cannot host this SDK's card path, and should say so rather than shipping a weaker option.

## 7. Card step machine

`nextCardStep(result, fallback?)` is pure and total: junk in, a step out. Actions:

`poll`, `confirm_inline`, `collect_otp`, `collect_avs`, `collect_pin`, `redirect`, `done`.

`driveCardVerification({vault, result, onVerification, maxAttempts})` loops those steps through a
callback. A rejected OTP is a re-prompt, not a dead end, and the loop is bounded.

The vault's server-action ids (`mintTokenizeGrant`, `tokenizeCardWithGrantRetry`,
`completeCardCheckout`, `authorizeCardStep`, `authorizePinViaVault`, `pollChargeStatus`) are per
build, and **all six differ between sandbox and live**. Resolve them at runtime by crawling
`/_next/static/chunks/*.js` for `createServerReference` calls; never hardcode, and never ship
sandbox ids as a live fallback.

The JS SDK exposes this as `discoverCardActions(checkoutOrigin, token)` plus
`CheckoutSession#refreshCardActions()`. Ports must implement the same two, with the same names,
because a port without it cannot charge a live card at all. Bound the crawl (250 chunks, 8 at a
time), stop once all six are found, and surface `ACTION_STALE` when a request still 404s so callers
can refresh and retry once.

Both bundled and escaped call forms occur in the same bundle, so match:
`createServerReference)(" <20-64 hex> ", " <actionName> ")` with optional backslashes before the quotes.

## 8. Errors

Everything throws one error type carrying `status`, `code` (the API's `error_code`), `detail` and
the parsed `body`. The API's envelope is `{ detail, error_code, errors? }` and its validation errors
are pydantic's, so `errors` is a list of `{field, message, type}`.

Known codes: `UNAUTHORIZED`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`,
`PAYMENT_METHOD_NOT_ALLOWED`, `ACTION_FAILED`, `ACTION_STALE`, `TOKENIZE_FAILED`.

`isUncertainWrite(err)` is true on a timeout, a 5xx, or a network drop after the request was sent.
Those are the cases where the charge may have happened, so reconcile before retrying. A 4xx is not
uncertain; it is an answer.

## 9. Webhooks

Header `X-Bachs-Signature-V2`: `t=<unix>,v1=<hex>[,v1=<hex>]`. HMAC-SHA256 over `"{t}.{rawBody}"`,
compared in constant time, five-minute tolerance, several `v1` values valid during rotation.

Verify the **raw bytes** before parsing. A framework that parses JSON first will re-serialise the
body and the signature will never match.

## 10. What each port needs

| Concern | PHP | Python |
| --- | --- | --- |
| HTTP | `curl` or Guzzle, HTTP client injected | `httpx` or `requests`, client injected |
| RSA-OAEP-SHA256 | `openssl_public_encrypt($data, $out, $pem, OPENSSL_PKCS1_OAEP_PADDING)` with an SHA-256 digest | `cryptography` `padding.OAEP(mgf=MGF1(SHA256), algorithm=SHA256)` |
| AES-256-GCM | `sodium_crypto_aead_aes256gcm_encrypt` (requires hardware support; check and degrade loudly) | `cryptography` `AESGCM` |
| UUID v4 | `bin2hex(random_bytes(16))`, set version and variant bits | `uuid.uuid4()` |
| Decimals | keep strings; `json_decode` with default flags is fine because the API sends strings | keep `str`; do not coerce to `Decimal` for display |
| Packaging | Composer, PSR-4, `bachs/checkout` | `pyproject.toml`, `bachs-checkout`, typed with `py.typed` |

Both ports should keep zero runtime dependencies where the language allows it, and make the HTTP
client injectable so tests need no network.

## 11. Parity checklist

- [ ] Client constructor accepts `secretKey`, optional `baseUrl`/`timeoutMs`, and derives hosts from the key prefix.
- [ ] Every private resource and method in section 3 exists with the same name.
- [ ] `CheckoutSession` accepts `environment` and exposes it; `fromUrl` sets both hosts.
- [ ] All 15 public methods in section 4 exist with the same argument names.
- [ ] `Idempotency-Key` on every write.
- [ ] `normalise` returns the five `type` values, with `null` fields preserved rather than omitted.
- [ ] Card sealing produces `{encrypted_key, iv, ciphertext}` that the vault accepts.
- [ ] `discoverCardActions` / `refreshCardActions` exist and resolve 6/6 ids on a live token.
- [ ] `ACTION_STALE` is surfaced with that exact code so a caller can refresh and retry.
- [ ] `nextCardStep` handles all seven actions and never throws on junk.
- [ ] Error type carries `status`, `code`, `detail`, `body`; `isUncertainWrite` matches.
- [ ] Webhook verification works against raw bytes, rotation, and a stale timestamp.
- [ ] The shared fixtures in `tests/fixtures/*.json` produce identical output to the JS implementations.
- [ ] Amounts stay strings end to end.

## 12. Conformance

The fixtures in `tests/fixtures/` are the shared oracle: `bank.json`, `crypto.json`, `momo.json`,
`card.json`. Each holds a real API response. Ports should run the same inputs through their
`normalise`, `resolveRail` and `nextCardStep`, and diff against the JS output. A port that passes
the fixtures and the checklist is done, regardless of how idiomatic it looks.
