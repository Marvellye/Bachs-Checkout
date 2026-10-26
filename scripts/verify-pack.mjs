#!/usr/bin/env node
/**
 * Prove the published artifact, not the folder: pack the tarball, install it into a clean temp
 * directory, and import every export path the way a consumer would.
 *
 *   node scripts/verify-pack.mjs
 *
 * Catches the classic release failures: a file missing from `files`, a broken `exports` map, a
 * subpath that only resolves from inside the repo.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const EXPECTED_MAIN = [
  "Bachs", "BachsError", "CheckoutSession", "CardVault",
  "normalise", "resolveRail", "isUncertainWrite",
  "nextCardStep", "cardChallenge", "driveCardVerification", "AVS_FIELDS",
  "MIN_AMOUNT", "SANDBOX_API", "LIVE_API", "KNOWN_CARD_ACTIONS", "default",
];
const EXPECTED_BROWSER = ["sealCard", "fetchVaultKey", "deviceInformation", "nextActionUrl", "mountCardForm"];

/** npm/tar are .cmd shims on Windows; execFileSync needs the real name. */
const bin = (name) => (process.platform === "win32" && /^(npm|npx)$/.test(name) ? `${name}.cmd` : name);

/**
 * Read a .tgz listing without shelling out to tar: Windows ships a GNU tar that treats `C:\...` as
 * a remote host, and the flag to work around it is not portable.
 */
function listTarball(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const name = read(0, 100);
    const prefix = read(345, 500);
    const size = parseInt(read(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    if (type === "0" || type === "\0" || type === "") entries.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function run(cmd, args, cwd) {
  const windowsShim = process.platform === "win32" && /^(npm|npx)$/.test(cmd);
  if (windowsShim) {
    // Node refuses to spawn a .cmd without a shell (EINVAL). Pass one command string so the args
    // are not re-parsed as shell input.
    const line = `${bin(cmd)} ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
    return execFileSync(line, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
  }
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "bachs-verify-"));
let failures = 0;

try {
  console.log(`packing ${pkg.name}@${pkg.version} ...`);
  const packed = run("npm", ["pack", "--silent", "--pack-destination", work], root).trim().split("\n").pop().trim();
  const tarball = path.join(work, packed);
  if (!fs.existsSync(tarball)) throw new Error(`npm pack produced no tarball (${packed})`);

  const size = (fs.statSync(tarball).size / 1024).toFixed(1);
  console.log(`tarball: ${packed} (${size} kB)`);

  // What actually ships.
  const entries = listTarball(tarball).map((l) => l.replace(/^package\//, ""));
  console.log(`contents: ${entries.join(", ")}`);

  const mustShip = [`${pkg.main.replace("./", "")}`, "package.json", "README.md", "LICENSE"];
  for (const file of mustShip) {
    if (!entries.includes(file)) {
      console.error(`FAIL missing from tarball: ${file}`);
      failures += 1;
    }
  }
  const mustNotShip = [/^tests\//, /\.env/, /\.card\.json/, /node_modules/, /^spec\//];
  for (const pattern of mustNotShip) {
    const hit = entries.find((e) => pattern.test(e));
    if (hit) {
      console.error(`FAIL should not ship: ${hit}`);
      failures += 1;
    }
  }

  // Install it somewhere clean and import every entry.
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "bachs-consumer-"));
  try {
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
    run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], consumer);
    console.log("installed into a clean directory");

    const probe = `
      const main = await import(${JSON.stringify(pkg.name)});
      const browser = await import(${JSON.stringify(`${pkg.name}/browser`)});
      const expectedMain = ${JSON.stringify(EXPECTED_MAIN)};
      const expectedBrowser = ${JSON.stringify(EXPECTED_BROWSER)};
      const missingMain = expectedMain.filter((k) => !(k in main));
      const missingBrowser = expectedBrowser.filter((k) => !(k in browser));
      if (missingMain.length) { console.error("missing main exports:", missingMain); process.exit(1); }
      if (missingBrowser.length) { console.error("missing browser exports:", missingBrowser); process.exit(1); }

      // The export map must resolve to the files that actually exist.
      const client = new main.Bachs({ secretKey: "sk_sandbox_verify" });
      if (client.baseUrl !== main.SANDBOX_API) { console.error("base URL detection broken"); process.exit(1); }
      const live = new main.Bachs({ secretKey: "sk_live_verify" });
      if (live.baseUrl !== main.LIVE_API) { console.error("live base URL detection broken"); process.exit(1); }

      const step = main.nextCardStep({ auth_model: "OTP", next_action: { type: "requires_otp", can_resend: true } });
      if (step.action !== "collect_otp") { console.error("card verification step mapping broken"); process.exit(1); }

      console.log("main   :", Object.keys(main).sort().join(", "));
      console.log("browser:", Object.keys(browser).sort().join(", "));
    `;
    fs.writeFileSync(path.join(consumer, "probe.mjs"), probe);
    console.log(run("node", ["probe.mjs"], consumer).trim().split("\n").map((l) => `  ${l}`).join("\n"));
    console.log("imports ok");
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`FAIL ${err.message}`);
  failures += 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nverify-pack: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`\nverify-pack: ${pkg.name}@${pkg.version} is publishable`);
