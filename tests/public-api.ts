/**
 * Type-level test for the public API. Nothing here runs: `npm run typecheck` compiles it with
 * `--strict` and `--noEmit`, so a type that drifts away from the JS will fail CI.
 *
 * Keep every claim the README makes about the API represented here.
 */
import {
  Bachs,
  BachsError,
  CheckoutSession,
  CardVault,
  MIN_AMOUNT,
  normalise,
  resolveRail,
  isUncertainWrite,
  nextCardStep,
  cardChallenge,
  driveCardVerification,
  KNOWN_CARD_ACTIONS,
  SANDBOX_API,
  LIVE_API,
  SANDBOX_CHECKOUT,
  LIVE_CHECKOUT,
  AVS_FIELDS,
} from "../src/index.js";

import { sealCard, deviceInformation, fetchVaultKey, mountCardForm } from "../src/browser.js";

/* --------------------------------------------------------------- client */

const bachs = new Bachs({ secretKey: "sk_live_abc" });
const liveBase: string = bachs.baseUrl;
void liveBase;

const sandboxBase: string = new Bachs({ secretKey: "sk_sandbox_abc", baseUrl: SANDBOX_API }).baseUrl;
void sandboxBase;

/* ------------------------------------------------------- checkout session */

const session = new CheckoutSession("B_token", {
  environment: "live",
  timeoutMs: 30000,
  cardActionIds: { mintTokenizeGrant: "abc" },
});
const environment: "live" | "sandbox" = session.environment;
const apiBase: string = session.apiBase;
const checkoutOrigin: string = session.checkoutOrigin;
void environment, apiBase, checkoutOrigin;

// `apiBase` alone must also be accepted, and the token-only form must stay valid.
new CheckoutSession("B_token", { apiBase: LIVE_API });
new CheckoutSession("B_token");
CheckoutSession.fromUrl("https://checkout.bachs.io/c/B_token");

const rail = resolveRail({ rail: "momo_ghs" });
const railCurrency: string = rail.currency;
void railCurrency;

const floor: Record<string, number> = MIN_AMOUNT;
void floor;

/* ------------------------------------------------------------- vault */

const vault = new CardVault({ token: "B_token", checkoutOrigin: SANDBOX_CHECKOUT });
void vault.publicKey();
void vault.tokenize({
  card_number: "4242424242424242",
  expiry_month: 9,
  expiry_year: 2033,
  cvv: "431",
});
void vault.authorizeOtp({ chargeId: "ch_1", otp: "123456" });
void vault.authorizePin({ chargeId: "ch_1", pin: "1234" });
void vault.submitAvs({
  chargeId: "ch_1",
  address: { line1: "1 Way", city: "Lagos", state: "LA", postal_code: "100001" },
});

/* -------------------------------------------------- card step machinery */

// The narrowest CompleteResponse the helpers accept, so the parameter types stay strict.
const complete = { payment_type: "processing" } as const;
const step = nextCardStep(complete, { chargeId: "ch_1" });
const action: string = step.action;
void action;

void cardChallenge(complete);
void isUncertainWrite(new BachsError(500, { detail: "boom" }, "uncertain"));

/* ------------------------------------------------------------ browser */

void sealCard("-----BEGIN PUBLIC KEY-----", {
  card_number: "4242424242424242",
  expiry_month: 9,
  expiry_year: 2033,
  cvv: "431",
});
void deviceInformation();
void fetchVaultKey(SANDBOX_CHECKOUT);
void mountCardForm({ root: {} as HTMLElement, onSubmit: () => undefined });

/* ------------------------------------------------------------- exports */

const constants: string[] = [SANDBOX_API, LIVE_API, SANDBOX_CHECKOUT, LIVE_CHECKOUT];
void constants;
void Object.keys(KNOWN_CARD_ACTIONS);
void AVS_FIELDS;
void normalise;
void driveCardVerification;
