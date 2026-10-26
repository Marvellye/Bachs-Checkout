# Contributing

Thanks for helping. This is a payments library, so the bar for evidence is higher than usual: a
change that "probably works" is not ready.

## Ground rules

1. **No secrets in a PR.** Not your key, not a sandbox key, not a webhook secret, not a real card
   number — not even redacted-looking ones. `.env`, `*.postman_environment.json` (with a key) and
   `.card.json` are gitignored; keep it that way.
2. **No fabricated test output.** If you could not run a rail, say which one and why.
3. **Card data never reaches a server in plaintext.** Any PR that posts a PAN to a backend will be
   closed. Sealed payloads or Elements only.
4. **Money is a decimal string.** No `parseFloat` on an amount, anywhere.

## Setup

```bash
git clone https://github.com/Marvellye/Bachs-Checkout.git
cd Bachs-Checkout
npm test                      # unit tests only: no credentials needed
cp .env.example .env          # add a SANDBOX key to run integration tests
npm run test:integration
```

Get a sandbox key at [app.bachs.io](https://app.bachs.io) → switch to **Sandbox** → Developer → API
keys. Sandbox keys start with `sk_sandbox_` and cannot move real money.

## What a good PR looks like

- **Bug fix:** a failing test that reproduces it, then the fix, then the test passing.
- **New rail or field:** a unit test with a captured response fixture in `tests/fixtures/`, plus a
  note on which sandbox call produced it.
- **Behaviour change to the public surface:** update `src/index.d.ts`, `README.md` and `CHANGELOG.md`
  in the same PR. Mention it in the PR description as breaking or not.

## Tests

```bash
npm test                 # 58 tests, no network - this is what CI runs
npm run test:integration # every rail against the sandbox; needs BACHS_SECRET_KEY
npm run postman:smoke    # chained Postman flow through newman
```

Integration tests create real sandbox sessions and charges. They refuse to run with a `sk_live_` key,
by design — do not remove that check.

Card verification (`src/card-verification.js`) is fixture-driven and must stay pure: `nextCardStep`
takes a response and returns a step, with no I/O. If you add a challenge type, add its fixture, its
`nextCardStep` case, and a request-payload test asserting the exact arguments.

When adding a fixture, capture it from the sandbox and then **sanitise** it: replace charge ids,
checkout tokens, client secrets, addresses and account numbers with obviously fake values. Commit
the shape, never the transaction.

## Code style

- ESM only, Node 18+, zero runtime dependencies.
- Plain JavaScript with JSDoc; `src/index.d.ts` must stay in sync.
- Errors: throw `BachsError` for API failures, `Error` with a `code` for local failures.
- Prefer returning the provider's response untouched under `raw` over reshaping it.

## Reporting a security issue

Do not open a public issue — see [SECURITY.md](./SECURITY.md).

## Regenerating the Postman collection

```bash
python3 tools/build-postman.py --fetch      # spec from docs.bachs.io + tests/fixtures as examples
```

Only the curated folders (SDK flow, public checkout API, card vault) are hand-written; everything
else comes from the spec, so spec changes flow through automatically.
