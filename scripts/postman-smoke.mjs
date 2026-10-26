#!/usr/bin/env node
/**
 * Run a short, chained slice of the Postman collection with newman.
 *
 *   npm run postman:smoke                 # catalog flow
 *   npm run postman:smoke -- adhoc        # product-less raw amount
 *   npm run postman:smoke -- custom       # buyer-chosen amount
 *
 * Needs a Postman environment that carries a sandbox key; generate one with:
 *   python3 tools/build-postman.py        (reads .env)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const collectionPath = path.join(root, "postman", "Bachs-API.postman_collection.json");
const envPath = process.argv[3] || path.join(root, "postman", "Bachs-Sandbox.postman_environment.json");
const profile = process.argv[2] || "catalog";

const PROFILES = {
  catalog: [
    ["SDK Flow: create the payment", ["1. Create product", "2. Create checkout session"]],
    ["Custom UI: drive the checkout (public API)",
      ["1. Detail", "2a. Requirements: bank", "3. Quote", "4a. Complete: bank", "5. Charge status"]],
  ],
  adhoc: [
    ["SDK Flow: create the payment", ["2b. Create checkout session - RAW AMOUNT"]],
    ["Custom UI: drive the checkout (public API)",
      ["1. Detail", "2a. Requirements: bank", "3. Quote", "4a. Complete: bank", "5. Charge status"]],
  ],
  custom: [
    ["SDK Flow: create the payment", ["2c. Create checkout session - BUYER-CHOSEN"]],
    ["Custom UI: drive the checkout (public API)",
      ["1. Detail", "1b. Set amount", "2a. Requirements: bank", "3. Quote", "4a. Complete: bank"]],
  ],
};

if (!PROFILES[profile]) {
  console.error(`unknown profile "${profile}" - choose one of: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}
if (!fs.existsSync(collectionPath)) {
  console.error(`missing ${collectionPath} - run: python3 tools/build-postman.py`);
  process.exit(1);
}
if (!fs.existsSync(envPath)) {
  console.error(
    `missing environment ${envPath}\n` +
    "Create one (with your sandbox key) before running the smoke test:\n" +
    "  cp postman/Bachs-Sandbox.postman_environment.example.json postman/Bachs-Sandbox.postman_environment.json\n" +
    "  # then paste your sk_sandbox_... key into BACHS_SECRET_KEY"
  );
  process.exit(1);
}

const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
const folders = [];
let total = 0;
for (const [folderName, prefixes] of PROFILES[profile]) {
  const folder = collection.item.find((f) => f.name === folderName);
  if (!folder) {
    console.error(`folder not found in collection: ${folderName}`);
    process.exit(1);
  }
  const items = folder.item.filter((i) => prefixes.some((p) => i.name.startsWith(p)));
  total += items.length;
  folders.push({ name: folderName, item: items });
}

const subset = { ...collection, item: folders, info: { ...collection.info, name: `Bachs smoke (${profile})` } };
const tmp = path.join(os.tmpdir(), `bachs-smoke-${profile}.postman_collection.json`);
fs.writeFileSync(tmp, JSON.stringify(subset, null, 2));
console.log(`running ${total} requests (profile: ${profile})`);

const child = spawn(
  "npx",
  ["--yes", "newman", "run", tmp, "-e", envPath, "--reporters", "cli"],
  { stdio: "inherit", shell: process.platform === "win32" }
);
child.on("exit", (code) => {
  fs.rmSync(tmp, { force: true });
  process.exit(code ?? 1);
});
