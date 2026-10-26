# Security policy

This library handles payment credentials. Please treat findings accordingly.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(<https://github.com/Marvellye/Bachs-Checkout/security/advisories/new>).

Include: affected version, what an attacker gains, reproduction steps, and whether it needs a live
key. Expect an acknowledgement within 72 hours and a fix or mitigation plan within 7 days for
confirmed issues.

## Scope

In scope:

- Plaintext card data (PAN, CVV, expiry, PIN) leaving the process, reaching logs, or being stored.
- The sealing scheme in `src/card-vault.js` (`seal`/`tokenizeSealed`) or `src/browser.js` (`sealCard`):
  nonce reuse, weak key handling, unverified ciphertext, a way to make the server accept an unsealed
  payload.
- Webhook signature verification bypasses (`Bachs.verifyWebhook` / `constructEvent`): timing leaks,
  missing timestamp check, accepting a signature over a re-serialised body.
- Secret leakage: keys or webhook secrets in errors, logs, telemetry or thrown objects.
- SSRF or origin-confusion in `CardVault` (requests must go to the configured checkout origin only).
- Anything that turns an idempotency bug into a double charge.

Out of scope:

- Vulnerabilities in Bachs' own API or checkout page — report those to Bachs at support@bachs.io.
- The undocumented nature of the public checkout API (a documented caveat, not a bug).
- Findings from a live account you do not own.
- Missing PCI certification: this library does not make you PCI compliant. See README → Caveats.

## Handling of credentials in this project

- Sandbox keys live in `.env` (gitignored) or a password manager; never in a commit, issue or PR.
- `scripts/live-check.mjs` reads the key from an env var or `--env-file`, never argv, and prints only
  a four-character fingerprint.
- Card details for live testing come from `--card-file` (gitignored), never the command line.
- Integration tests throw if given a `sk_live_` key.

## Supported versions

Pre-1.0: the latest published minor version receives fixes.
