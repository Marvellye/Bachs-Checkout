/** Temporary: dump the API client chunk of the current sandbox checkout build. */
import fs from "node:fs";

const ua = { "User-Agent": "Mozilla/5.0 BachsSDKProbe" };
const origin = "https://sandbox-checkout.bachs.io";
const page = fs.readFileSync(".cache/page.html", "utf8");
const assets = [...new Set([...page.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];

for (const asset of assets) {
  const res = await fetch(`${origin}${asset}`, { headers: ua });
  const body = await res.text();
  const name = asset.split("/").pop();
  fs.writeFileSync(`.cache/${name}`, body);

  const hits = [];
  for (const re of [
    /["'`][^"'`]{0,40}\/v1\/[A-Za-z0-9/_{}$.-]*/g,
    /["'`][^"'`]{0,30}\/api\/[A-Za-z0-9/_{}$.-]*/g,
    /(?:get|post|put|patch)\(\s*`[^`]+`/g,
  ]) {
    for (const m of body.matchAll(re)) hits.push(m[0]);
  }

  const unique = [...new Set(hits)];
  if (!unique.length) continue;
  console.log(`\n=== ${name} (${body.length} bytes)`);
  for (const h of unique.slice(0, 60)) console.log("  ", h.slice(0, 130));
}
