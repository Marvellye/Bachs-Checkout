/**
 * Browser half of the card rail.
 *
 * Card data is sealed in the page with WebCrypto before it leaves the browser, so your backend only
 * ever receives `{ encrypted_key, iv, ciphertext }`. Your server then calls the vault actions
 * (see `CardVault` in the main entry point).
 *
 * Do NOT post raw card fields to your own server. Either seal here, or use Stripe Elements with the
 * `inline` rail's client_secret. Those are the only two shapes that keep card data out of your storage.
 */

/** Fetch the vault's RSA-OAEP-256 public key from the checkout origin. */
export async function fetchVaultKey(checkoutOrigin = "https://sandbox-checkout.bachs.io") {
  const res = await fetch(`${checkoutOrigin.replace(/\/+$/, "")}/api/vault/public-key`);
  if (!res.ok) throw new Error(`vault public key -> HTTP ${res.status}`);
  const { public_key_pem: pem } = await res.json();
  if (!pem) throw new Error("vault public key response carried no public_key_pem");
  return pem;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Seal card data in the page: AES-256-GCM for the payload, RSA-OAEP-SHA256 for the key.
 * Byte-for-byte the same scheme the hosted checkout uses.
 *
 * @param {string} publicKeyPem
 * @param {{card_number: string, expiry_month: number|string, expiry_year: number|string, cvv: string, cardholder_name?: string}} card
 * @param {string} [pin]
 */
export async function sealCard(publicKeyPem, card, pin) {
  const pem = publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const rsaKey = await crypto.subtle.importKey(
    "spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
  );
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const payload = pin ? { ...card, pin } : { ...card };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify(payload))
  );
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" }, rsaKey, await crypto.subtle.exportKey("raw", aesKey)
  );

  return { encrypted_key: b64(encryptedKey), iv: b64(iv), ciphertext: b64(ciphertext) };
}

/** Device fingerprint some issuers want for risk scoring; same fields the hosted checkout sends. */
export function deviceInformation() {
  const nav = globalThis.navigator || {};
  const scr = globalThis.screen || {};
  return {
    java_enabled: false,
    javascript_enabled: true,
    ...(nav.language ? { browser_language: String(nav.language).slice(0, 35) } : {}),
    ...(scr.colorDepth ? { color_depth: scr.colorDepth } : {}),
    ...(scr.height ? { screen_height: scr.height } : {}),
    ...(scr.width ? { screen_width: scr.width } : {}),
    time_zone_offset_minutes: -new Date().getTimezoneOffset(),
  };
}

/**
 * A 3DS step-up or processor approval must be a real top-level navigation, not a fetch.
 * Returns the URL to navigate to, or null.
 */
export function nextActionUrl(nextAction) {
  if (!nextAction) return null;
  return nextAction.redirect_url || nextAction.redirect_to_url?.url || nextAction.payment_url || null;
}

/**
 * Minimal custom-UI card form: your markup, your styles, WebCrypto sealing underneath.
 *
 *   const form = mountCardForm({
 *     root: document.querySelector("#card-form"),
 *     checkoutOrigin: "https://sandbox-checkout.bachs.io",
 *     onSubmit: async (sealed, device) => {
 *       const r = await fetch("/api/pay/card", { method: "POST", body: JSON.stringify({ sealed, device }) });
 *       return r.json();               // your server calls CardVault.tokenize + complete
 *     },
 *     onError: (err) => showError(err.message),
 *   });
 *
 * Inputs are read by name: `data-bachs-card="number|expiry|cvv|name"`.
 */
export function mountCardForm({ root, checkoutOrigin, onSubmit, onError } = {}) {
  if (!root) throw new Error("root element is required");
  const read = (name) => root.querySelector(`[data-bachs-card="${name}"]`)?.value?.trim() || "";
  let pem = null;

  async function handle(event) {
    event?.preventDefault?.();
    try {
      const number = read("number").replace(/\s+/g, "");
      const expiry = read("expiry");
      const [mm, yy] = expiry.split("/").map((s) => s.trim());
      const cvc = read("cvv");

      if (!/^\d{12,19}$/.test(number)) throw new Error("Enter a valid card number");
      if (!mm || !yy) throw new Error("Enter the expiry as MM/YY");
      if (!/^\d{3,4}$/.test(cvc)) throw new Error("Enter the CVV");

      pem = pem || (await fetchVaultKey(checkoutOrigin));
      const sealed = await sealCard(pem, {
        card_number: number,
        expiry_month: Number(mm),
        expiry_year: yy.length === 2 ? Number(`20${yy}`) : Number(yy),
        cvv: cvc,
        ...(read("name") ? { cardholder_name: read("name") } : {}),
      });

      // Clear the plaintext as soon as it is sealed.
      for (const name of ["number", "expiry", "cvv"]) {
        const el = root.querySelector(`[data-bachs-card="${name}"]`);
        if (el) el.value = "";
      }

      return await onSubmit?.(sealed, deviceInformation());
    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  root.addEventListener("submit", handle);
  return { submit: handle, destroy: () => root.removeEventListener("submit", handle) };
}
