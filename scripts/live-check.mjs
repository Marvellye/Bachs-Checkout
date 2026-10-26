#!/usr/bin/env node
/**
 * Bachs live-credentials check (see scripts/README.md).
 *
 * Safe by default: with no flags it only READS - it proves the key, the account, the enabled rails and
 * the webhook endpoint config, and prints the card-vault action ids the live build is using. No money
 * moves, no object is created.
 *
 *   node scripts/live-check.mjs                          # preflight on live key, read-only
 *   node scripts/live-check.mjs --pay --method bank --amount 100 --currency NGN
 *   node scripts/live-check.mjs --pay --method crypto --amount 1.00 --currency USD --crypto USDT_TRC20
 *   node scripts/live-check.mjs --pay --method momo --amount 1.00 --currency GHS --phone +233201234567 --rail mtn
 *   node scripts/live-check.mjs --pay --method card --amount 1.00 --currency USD --card-file .card.json
 *
 * Card data never goes on the command line. For CI, pass --yes; interactive runs must type CHARGE.
 *
 * Key resolution order:
 *   1. --env-file <path>        e.g. .env.live
 *   2. BACHS_LIVE_SECRET_KEY    environment variable
 *   3. BACHS_SECRET_KEY         environment variable (whatever it is - detected, not trusted)
 *
 * Wrong environment is refused: a sk_live_ key pointed at a sandbox host (or vice versa) aborts.
 *
 * Card details never go on the command line (shell history). Use --card-file with:
 *   { "number": "4242...", "exp_month": 9, "exp_year": 2033, "cvc": "123" }
 * and put that file in .gitignore. The PAN is sealed to Bachs' vault key before it leaves this process.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { Bachs, CheckoutSession, KNOWN_CARD_ACTIONS } from "../src/index.js";
import { discoverActions } from "./discover-actions.mjs";

const LIVE = { api: "https://api.bachs.io", checkout: "https://checkout.bachs.io" };
const SANDBOX = { api: "https://sandbox-api.bachs.io", checkout: "https://sandbox-checkout.bachs.io" };
const UA = "bachs-checkout-live-check/0.1.0";

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === "help") { out.help = true; continue; }
    if (key === "pay" || key === "yes" || key === "json") { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*\*?/, ""));
  process.exit(0);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green("OK")}   ${s}`);
const warn = (s) => console.log(`  ${c.yellow("WARN")} ${s}`);
const bad = (s) => console.log(`  ${c.red("FAIL")} ${s}`);
const line = () => console.log(c.dim("─".repeat(72)));

function die(msg) {
  console.error(`\n${c.red("aborted:")} ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------- key setup */

function readEnvFile(file) {
  const env = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

let key = process.env.BACHS_LIVE_SECRET_KEY || process.env.BACHS_SECRET_KEY || "";
let webhookSecret = process.env.BACHS_LIVE_WEBHOOK_SECRET || process.env.BACHS_WEBHOOK_SECRET || "";
let fileEnv = {};

if (args["env-file"]) {
  const f = path.resolve(args["env-file"]);
  if (!fs.existsSync(f)) die(`env file not found: ${f}`);
  fileEnv = readEnvFile(f);
  key = fileEnv.BACHS_LIVE_SECRET_KEY || fileEnv.BACHS_SECRET_KEY || fileEnv.BACHS_API_KEY || key;
  webhookSecret = fileEnv.BACHS_LIVE_WEBHOOK_SECRET || fileEnv.BACHS_WEBHOOK_SECRET || webhookSecret;
}
if (args.key_env) key = process.env[args.key_env] || die(`environment variable ${args.key_env} is empty`);

if (!key) die("no API key. Set BACHS_LIVE_SECRET_KEY, pass --env-file, or --key-env NAME");
if (!/^sk_(live|sandbox)_/.test(key)) die("key does not look like sk_live_... or sk_sandbox_...");

const isLive = key.startsWith("sk_live_");
const env = isLive ? LIVE : SANDBOX;
const keyFingerprint = `sk_${isLive ? "live" : "sandbox"}_…${key.slice(-4)} (${key.length} chars)`;

/* --------------------------------------------------------------- helpers */

async function get(pathname, { base = env.api, headers = {} } = {}) {
  const res = await fetch(base + pathname, {
    headers: { Accept: "application/json", "User-Agent": UA, Authorization: `Bearer ${key}`, ...headers },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 300); }
  return { status: res.status, body };
}

function print(json) {
  if (args.json) console.log(JSON.stringify(json, null, 2));
  else console.log(JSON.stringify(json, null, 2));
}

/* ------------------------------------------------------------- preflight */

async function preflight() {
  const report = { environment: isLive ? "live" : "sandbox", key: keyFingerprint, baseUrl: env.api, checks: {} };

  line();
  console.log(c.bold("1. Authentication"));
  const me = await get("/v1/accounts/me");
  if (me.status !== 200) {
    bad(`/v1/accounts/me -> ${me.status} ${JSON.stringify(me.body).slice(0, 240)}`);
    if (me.status === 401) die("the key is rejected by this environment - wrong prefix or revoked");
    die("cannot read the account; fix auth before charging anything");
  }
  const acct = me.body;
  ok(`account ${acct.name || acct.id} · ${acct.country || "?"} · active=${acct.is_active}`);
  report.checks.account = { id: acct.id, name: acct.name, country: acct.country, active: acct.is_active };

  const rails = Object.entries(acct.enabled_payment_methods || {})
    .filter(([, v]) => v?.enabled)
    .map(([k]) => k);
  report.checks.rails = rails;
  if (rails.length) ok(`rails enabled: ${rails.join(", ")}`);
  else warn("no payment rails enabled on this account - charges will be refused");

  if (isLive) {
    const caps = acct.enabled_capabilities || [];
    if (caps.includes("card_collection") || caps.includes("bank_transfer")) ok(`capabilities: ${caps.join(", ")}`);
    else warn(`capabilities look thin: ${caps.join(", ") || "none"} - live account may not be verified`);
  }

  line();
  console.log(c.bold("2. Read access (money data)"));
  const payments = await get("/v1/payments?limit=1");
  if (payments.status === 200) {
    const total = payments.body?.pagination?.total ?? (payments.body?.items || []).length;
    ok(`/v1/payments readable (total ${total})`);
    report.checks.paymentsVisible = total;
  } else {
    bad(`/v1/payments -> ${payments.status} ${JSON.stringify(payments.body).slice(0, 200)}`);
    report.checks.paymentsVisible = null;
  }

  const products = await get("/v1/products?limit=1");
  if (products.status === 200) ok(`/v1/products readable (total ${products.body?.pagination?.total ?? "?"})`);
  else bad(`/v1/products -> ${products.status}`);

  line();
  console.log(c.bold("3. Webhooks (the source of truth for fulfilment)"));
  const hooks = await get("/v1/webhooks/endpoints");
  if (hooks.status === 200) {
    const items = hooks.body?.items || [];
    if (!items.length) {
      warn("no webhook endpoint registered - you would have no settlement signal");
    }
    for (const h of items) {
      const state = h.enabled ? c.green("enabled") : c.red(`disabled (${h.disabled_reason || "?"})`);
      ok(`${h.url} → ${state}, ${h.event_types?.length || 0} events`);
      if (!h.enabled) warn("re-enable it and re-verify the signing secret before trusting deliveries");
      const wanted = ["collection.succeeded", "checkout.completed"];
      const missing = wanted.filter((e) => !(h.event_types || []).includes(e));
      if (missing.length) warn(`missing events: ${missing.join(", ")}`);
    }
    report.checks.webhooks = items.map((h) => ({ url: h.url, enabled: h.enabled, reason: h.disabled_reason || null }));
  } else {
    warn(`cannot list webhook endpoints (${hooks.status}) - key may lack webhooks:read`);
  }
  if (webhookSecret) {
    ok(`webhook secret present (${webhookSecret.slice(0, 6)}…${webhookSecret.length} chars) - verify against the RAW body`);
  } else {
    warn("no webhook secret in the environment - you cannot verify deliveries");
  }

  line();
  console.log(c.bold("4. Card vault (live build)"));
  const probe = args["no-vault-check"] ? null : await probeVault();
  report.checks.vault = probe;

  return report;
}

/**
 * Confirm the live checkout build exposes the vault surface, and resolve its action ids.
 * Needs a checkout token; we mint a cheap session only when a payment is already planned,
 * otherwise we report that discovery is deferred rather than creating a session on a read-only run.
 */
async function probeVault(token) {
  const keyRes = await fetch(`${env.checkout}/api/vault/public-key`, { headers: { "User-Agent": UA } });
  if (!keyRes.ok) {
    bad(`vault public key -> HTTP ${keyRes.status} at ${env.checkout}`);
    return { publicKey: false };
  }
  const { public_key_pem: pem, algorithm } = await keyRes.json();
  ok(`vault public key reachable (${algorithm || "RSA-OAEP"})`);

  const out = { publicKey: true, algorithm: algorithm || null, actions: null };
  if (!token) {
    warn("action-id discovery needs a checkout token; it runs automatically before a card charge");
    return out;
  }

  try {
    const { actions, crawled, missing } = await discoverActions(env.checkout, token);
    out.actions = Object.fromEntries(Object.entries(actions).map(([k, v]) => [k, v.id]));
    if (missing.length) {
      warn(`crawled ${crawled} chunks, missing actions: ${missing.join(", ")}`);
      warn("card charges would fail on this build - re-check discover-actions.mjs");
    } else {
      ok(`resolved ${Object.keys(actions).length} card actions from ${crawled} chunks`);
      const drift = Object.entries(actions)
        .filter(([name, v]) => KNOWN_CARD_ACTIONS[name] && KNOWN_CARD_ACTIONS[name] !== v.id)
        .map(([name]) => name);
      if (drift.length) warn(`ids differ from the sandbox constants: ${drift.join(", ")} (expected on live)`);
    }
    if (pem) {
      const bytes = crypto.createPublicKey(pem).asymmetricKeyDetails?.modulusLength || "?";
      ok(`vault key strength: ${bytes} bit`);
      out.keyBits = bytes;
    }
  } catch (err) {
    bad(`action discovery failed: ${err.message}`);
  }
  return out;
}

/* --------------------------------------------------------------- payment */

/**
 * Approximate USD value of one unit of each supported currency.
 *
 * These are safety rails for a burn cap, NOT accounting rates: the charge itself is always priced by
 * Bachs' quote. A cap expressed in raw units is meaningless across currencies - 100 NGN is about 7
 * cents, while 100 USD is not - so the cap is denominated in USD-equivalents.
 */
const FX_TO_USD = {
  USD: 1, USDT: 1, USDC: 1,
  NGN: 1 / 1500, GHS: 1 / 12.2, KES: 1 / 129, TZS: 1 / 2550, UGX: 1 / 3750,
  XAF: 1 / 600, XOF: 1 / 600, RWF: 1 / 1400, MWK: 1 / 1750, ZMW: 1 / 27,
};

/**
 * Per-currency minimum for a product-less session, so the default never trips the floor.
 * Verified against the API: NGN rejects under 100.00, USD under 1.00 ("amount must be at least
 * 1.00 USD"). The same floors apply to crypto rails, which are priced from the USD base amount.
 */
const MIN_AMOUNT = { NGN: 100, USD: 1, USDT: 1, USDC: 1, GHS: 1, KES: 1, TZS: 1, UGX: 1, XAF: 1, XOF: 1, RWF: 1, MWK: 1, ZMW: 1 };

function defaultAmountFor(currency) {
  return MIN_AMOUNT[String(currency).toUpperCase()] ?? 1;
}

function usdEquivalent(amount, currency) {
  const rate = FX_TO_USD[String(currency).toUpperCase()];
  return rate === undefined ? null : amount * rate;
}

function guardAmount(currency) {
  const amount = Number(args.amount ?? defaultAmountFor(currency));
  if (!Number.isFinite(amount) || amount <= 0) die("--amount must be a positive number");

  const cur = String(currency).toUpperCase();
  const floor = MIN_AMOUNT[cur];
  if (floor && amount < floor) {
    die(`${cur} amounts have a ${floor.toFixed(2)} floor on product-less sessions (VALIDATION_ERROR)`);
  }

  // Absolute cap in the payment currency, if the operator wants one.
  if (args["max-amount"] !== undefined) {
    const absolute = Number(args["max-amount"]);
    if (!Number.isFinite(absolute) || absolute <= 0) die("--max-amount must be a positive number");
    if (amount > absolute) die(`--amount ${amount} ${cur} exceeds --max-amount ${absolute}`);
  }

  // Burn cap in USD-equivalents.
  const maxUsd = Number(args["max-usd"] ?? (isLive ? 2 : 5));
  const usd = usdEquivalent(amount, cur);
  if (usd === null) {
    die(`no safety rate for ${cur}: pass --max-amount ${amount} to acknowledge the absolute cap explicitly`);
  }
  if (usd > maxUsd) {
    die(`--amount ${amount} ${cur} (~$${usd.toFixed(2)}) exceeds --max-usd ${maxUsd}: refusing to move that much money`);
  }

  return { amount, currency: cur, usd };
}

function readCard() {
  const file = args["card-file"];
  if (!file) die("card payments need --card-file (never pass a PAN on the command line)");
  const p = path.resolve(file);
  if (!fs.existsSync(p)) die(`card file not found: ${p}`);
  const card = JSON.parse(fs.readFileSync(p, "utf8"));
  const number = String(card.number || card.card_number || "").replace(/\s+/g, "");
  const month = Number(card.exp_month || card.expiry_month);
  const year = Number(card.exp_year || card.expiry_year);
  const cvc = String(card.cvc || card.cvv || "");
  if (!/^\d{12,19}$/.test(number)) die("card file: invalid number");
  if (!month || !year) die("card file: exp_month / exp_year required");
  if (!/^\d{3,4}$/.test(cvc)) die("card file: cvc required");
  return { card_number: number, expiry_month: month, expiry_year: year < 100 ? 2000 + year : year, cvv: cvc };
}

async function confirm(plan) {
  if (args.yes) {
    warn("--yes passed: charging without confirmation");
    return;
  }
  if (!process.stdin.isTTY) die("not a TTY and --yes was not passed; refusing to charge unattended");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const usdHint = plan.usd === null || plan.usd === undefined ? "" : c.dim(` (~$${plan.usd.toFixed(2)})`);
  const answer = await rl.question(
    `\nThis will charge ${c.bold(plan.amount + " " + plan.currency)}${usdHint} via ${c.bold(plan.method)} on ${c.bold(plan.environment.toUpperCase())}.\n` +
    `Type ${c.bold("CHARGE")} to continue: `
  );
  rl.close();
  if (answer.trim() !== "CHARGE") die("not confirmed");
}

async function pay() {
  const method = String(args.method || "bank").toLowerCase();
  const currency = String(args.currency || (method === "bank" ? "NGN" : "USD")).toUpperCase();
  // Validate before printing a section header or touching the network.
  const budget = guardAmount(currency);
  const { amount } = budget;

  // Rail-specific inputs are validated before a session exists, so a typo never leaves an orphan
  // session (or a live checkout link) behind.
  if (method === "momo" && !args.phone) die("mobile money needs --phone, e.g. --phone +233201234567");
  if (method === "crypto" && !args.crypto && !args.currency) die("crypto needs the corridor, e.g. --crypto USDT_TRC20");
  const card = method === "card" ? readCard() : null;

  const reference = args.reference || `LIVE-TEST-${Date.now()}`;

  line();
  console.log(c.bold("5. Payment"));
  const plan = { method, amount, currency, environment: isLive ? "live" : "sandbox", reference, usd: budget.usd };
  await confirm(plan);

  const bachs = new Bachs({ secretKey: key });
  console.log(`\n${c.bold("Creating session")} (${amount} ${currency}, reference ${reference})`);
  const session = await bachs.checkoutSessions.create({
    pricing: { currency, amount: String(amount) },
    customer: { email: args.email || "customer@example.com", name: "Live Test" },
    success_url: args["success-url"] || "https://example.com/paid",
    cancel_url: args["cancel-url"] || "https://example.com/cancelled",
    reference,
    metadata: { source: "live-test-script" },
  });
  console.log(`  session ${session.checkout_id} · ${session.amount} ${session.currency}`);
  console.log(`  checkout ${c.dim(session.checkout_url)}`);

  // Resolve the live vault build before a card charge.
  let cardActionIds;
  if (method === "card") {
    const { actions, missing } = await discoverActions(env.checkout, session.checkout_url.split("/").pop());
    if (missing.length) die(`cannot resolve card actions on this build: ${missing.join(", ")}`);
    cardActionIds = Object.fromEntries(Object.entries(actions).map(([k, v]) => [k, v.id]));
    ok("card actions resolved from the live build");
  }

  const checkout = new CheckoutSession(session.checkout_url.split("/").pop(), {
    apiBase: env.api,
    checkoutOrigin: env.checkout,
    ...(cardActionIds ? { cardActionIds } : {}),
  });

  const railArgs = {
    rail: method === "momo" ? `momo_${currency.toLowerCase()}` : method,
    currency,
    ...(args.phone ? { phone: args.phone } : {}),
    ...(args.rail ? { paymentRail: args.rail } : {}),
    ...(method === "crypto" ? { currency: String(args.crypto || currency) } : {}),
    ...(card ? { card } : {}),
  };

  console.log(`\n${c.bold("Paying")} via ${method}`);
  const payment = await checkout.pay(railArgs);
  console.log(`  type=${payment.type} charge=${payment.chargeId || "—"} txn=${payment.transactionId || "—"}`);
  if (payment.instructions) {
    line();
    console.log(c.bold("Instructions (render these exactly)"));
    for (const [k, v] of Object.entries(payment.instructions)) {
      if (v === null || v === "") continue;
      console.log(`  ${k.padEnd(18)} ${String(v).length > 120 ? String(v).slice(0, 60) + "…" : v}`);
    }
  }

  const wait = Number(args.wait ?? (payment.chargeId ? 120 : 0));
  let final = null;
  if (payment.chargeId && wait > 0) {
    console.log(`\n${c.bold("Polling")} up to ${wait}s for a terminal state`);
    final = await checkout.waitForPayment(payment.chargeId, {
      timeoutMs: wait * 1000,
      intervalMs: 3000,
      onTick: (s) => console.log(`  ${s.charge_status} / ${s.substatus ?? "—"} / ${s.attempt_status ?? "—"}`),
    });
  }

  const server = await bachs.checkoutSessions.get(session.checkout_id);

  const result = {
    environment: plan.environment,
    session: { id: session.checkout_id, amount: session.amount, currency: session.currency, url: session.checkout_url },
    payment: {
      type: payment.type, chargeId: payment.chargeId, transactionId: payment.transactionId,
      instructions: payment.instructions || null, nextAction: payment.nextAction || null
    },
    final: final && {
      charge_status: final.charge_status, substatus: final.substatus, attempt_status: final.attempt_status,
      failure_code: final.failure_code, failure_message: final.failure_message,
      amount_paid: final.amount_paid, amount_remaining: final.amount_remaining,
    },
    settled: server.status,
  };

  line();
  const settledOk = final ? ["paid", "succeeded", "completed"].includes(String(final.charge_status).toLowerCase()) : null;
  if (settledOk === true) ok(`PAID ${final.amount_paid} ${session.currency} · charge ${payment.chargeId}`);
  else if (settledOk === false) bad(`not paid: ${final.charge_status} ${final.failure_code || ""} ${final.failure_message || ""}`);
  else warn("charge is still open - confirm from the collection.succeeded webhook, not from this script");
  console.log(c.dim(`  session status: ${server.status} · verify at app.bachs.io`));

  print(result);
  process.exit(settledOk === false ? 3 : 0);
}

/* ------------------------------------------------------------------ main */

console.log(c.bold(`\nBachs ${isLive ? "LIVE" : "sandbox"} check`));
console.log(c.dim(`  key      ${keyFingerprint}`));
console.log(c.dim(`  api      ${env.api}`));
console.log(c.dim(`  checkout ${env.checkout}`));
if (isLive) console.log(c.yellow("  live keys move real money. Read-only unless --pay is passed."));

const report = await preflight();

line();
if (!args.pay) {
  console.log(c.bold("Summary"));
  ok("preflight complete - nothing was created and no money moved");
  console.log(c.dim("  run again with --pay --method bank --amount 100 --currency NGN to charge"));
  print(report);
  process.exit(0);
}

try {
  await pay();
} catch (err) {
  const detail = err?.detail || err?.message || String(err);
  console.error(`\n${c.red("failed:")} ${detail}`);
  if (err?.code) console.error(c.dim(`  code ${err.code}`));
  if (err?.path) console.error(c.dim(`  path ${err.path}`));
  if (err?.status) console.error(c.dim(`  http ${err.status}`));
  console.error(c.dim("  nothing further was attempted"));
  process.exit(1);
}
