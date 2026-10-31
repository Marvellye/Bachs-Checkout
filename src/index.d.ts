// Type definitions for bachs-checkout
// Unofficial SDK for the Bachs payments API.

export declare const SANDBOX_API: string;
export declare const LIVE_API: string;
export declare const SANDBOX_CHECKOUT: string;
export declare const LIVE_CHECKOUT: string;

/** Minimum amount a product-less session accepts, per currency. */
export declare const MIN_AMOUNT: Record<string, number>;

export declare class BachsError extends Error {
  constructor(status: number, body: unknown, path: string);
  status: number;
  code: string | null;
  detail: string | null;
  body: unknown;
  path: string;
}

/** True when a write may have been applied despite the failure: reconcile before retrying. */
export declare function isUncertainWrite(err: unknown): boolean;

export interface Money {
  currency: string;
  amount: string;
}

export interface PricingInput extends Money {
  price_type?: "fixed" | "custom" | "free";
  preset_amount?: string;
  minimum_amount?: string;
  maximum_amount?: string;
  currency_options?: Record<string, string>;
}

export interface ProductCartItem {
  product_id: string;
  quantity?: number;
  /** Override the catalog price for this session only. */
  pricing?: Omit<PricingInput, "currency">;
}

export interface CustomerInput {
  email?: string;
  name?: string;
  customer_id?: string;
}

export interface CreateSessionInput {
  /** Catalog products. Mutually exclusive with `pricing`. */
  product_cart?: ProductCartItem[];
  /** Raw amount, no product. Mutually exclusive with `product_cart`. */
  pricing?: PricingInput;
  customer?: CustomerInput;
  success_url?: string;
  cancel_url?: string;
  reference?: string;
  metadata?: Record<string, string>;
  payment_method_types?: string[];
  billing_currency?: string;
  expires_in_minutes?: number;
  customer_creation?: "always" | "if_required";
  save_payment_method?: boolean;
  platform_fee?: string;
  transfer_data?: { destination: string; amount?: string };
}

export interface CheckoutSessionObject {
  checkout_id: string;
  checkout_url: string;
  status: "open" | "completed" | "expired" | "cancelled";
  amount: string;
  currency: string;
  reference: string | null;
  expires_at: string;
  created_at: string;
  client_secret?: string | null;
  products?: unknown[] | null;
  [key: string]: unknown;
}

export interface PaymentMethodOption {
  payment_method: string;
  label: string;
  currencies: string[];
}

export interface CheckoutDetail {
  checkout_id: string;
  status: string;
  mode: string;
  amount: string;
  currency: string;
  payment_required: boolean;
  price_type: "fixed" | "custom" | "free" | null;
  minimum_amount: string | null;
  maximum_amount: string | null;
  payment_methods: PaymentMethodOption[];
  customer: { id?: string; email?: string; name?: string } | null;
  customer_details: { email?: string; name?: string } | null;
  success_url: string | null;
  cancel_url: string | null;
  reference: string | null;
  expires_at: string;
  is_test_mode: boolean | null;
  products: unknown[] | null;
  billing_currency: string | null;
  [key: string]: unknown;
}

export interface RequirementField {
  id: string;
  label: string;
  type: string;
  options?: { label: string; value: string }[];
}

export interface NextStep {
  id: string;
  type: string;
  endpoint: string | null;
  inputs: string[] | null;
  requirements?: RequirementField[] | null;
}

export interface RequirementsResponse {
  status: string;
  fields: RequirementField[];
  current_step: NextStep;
  next_step: NextStep;
}

export interface QuoteResponse {
  quote_id: string;
  payment_method: string;
  payment_rail: string | null;
  base_amount_usd: string;
  amount_local_base: string;
  currency: string;
  processing_fee: string;
  exchange_rate: string | null;
  total_amount: string;
  payment_type: string;
  expires_at: string;
  customer_bears_fee: boolean;
  current_step: NextStep;
  next_step: NextStep;
}

export interface CompleteResponse {
  payment_type: "instructions" | "inline" | "processing" | "redirect";
  charge_id?: string;
  checkout_id?: string;
  transaction_id?: string;
  amount?: string;
  currency?: string;
  instructions?: Record<string, unknown> | null;
  client_secret?: string | null;
  next_action?: { type?: string; redirect_url?: string; can_resend?: boolean } | null;
  auth_model?: string | null;
  gateway_session_id?: string | null;
  polling_required?: boolean;
  payment_url?: string;
  expires_at?: string | null;
  [key: string]: unknown;
}

export interface ChargeStatus {
  charge_id: string;
  charge_status: string;
  substatus: string | null;
  checkout_status: string;
  attempt_status: string | null;
  attempt_failed: boolean;
  failure_message: string | null;
  failure_code: string | null;
  redirect_url: string | null;
  cancel_url: string | null;
  amount_paid: string;
  amount_remaining: string;
  updated_at: string;
}

export interface BankTransferInstructions {
  accountNumber: string | null;
  accountName: string | null;
  bankName: string | null;
  bankCode: string | null;
  amountExpected: string | null;
  reference: string | null;
  expiresAt: string | null;
  fee: string | null;
  vat: string | null;
}

export interface CryptoInstructions {
  address: string | null;
  network: string | null;
  currency: string | null;
  amount: string | null;
  /** `data:image/png;base64,...` */
  qrCode: string | null;
  expiresAt: string | null;
  expiresInMinutes: number | null;
}

export interface MobileMoneyInstructions {
  action: string | null;
  message: string | null;
}

interface NormalisedBase<R> {
  method: string;
  kind: string;
  chargeId: string | null;
  transactionId: string | null;
  amount: string | null;
  currency: string;
  quoteId: string | null;
  expiresAt: string | null;
  status: string | null;
  pollingRequired: boolean;
  /** The provider's untouched response. */
  raw: R;
}

export type NormalisedPayment =
  | (NormalisedBase<CompleteResponse> & { type: "bank_transfer"; instructions: BankTransferInstructions })
  | (NormalisedBase<CompleteResponse> & { type: "crypto"; instructions: CryptoInstructions })
  | (NormalisedBase<CompleteResponse> & { type: "mobile_money"; instructions: MobileMoneyInstructions })
  | (NormalisedBase<CompleteResponse> & {
      type: "card";
      clientSecret: string | null;
      nextAction: CompleteResponse["next_action"];
      authModel: string | null;
      gatewaySessionId: string | null;
    })
  | (NormalisedBase<CompleteResponse> & {
      type: "redirect";
      url: string;
      nextAction: CompleteResponse["next_action"];
      gatewaySessionId: string | null;
    });

export interface PayOptions {
  /** `card` | `bank` | `crypto` | `momo` | `momo_ghs` | `free`, or a raw payment method. */
  rail?: string;
  currency?: string;
  /** Mobile money number, `+countrycode…` or 7-10 local digits. */
  phone?: string;
  /** Mobile money network: mtn, vodafone, ... */
  paymentRail?: string;
  card?: {
    card_number: string;
    expiry_month: number | string;
    expiry_year: number | string;
    cvv: string;
    cardholder_name?: string;
    pin?: string;
  };
  cardOptions?: { deviceInformation?: Record<string, unknown> };
}

export declare function resolveRail(opts?: { rail?: string; currency?: string }): {
  paymentMethod: string;
  currency: string;
  kind: "card" | "bank_transfer" | "crypto" | "mobile_money" | "other";
};

export type CardStepAction =
  | "collect_otp"
  | "collect_pin"
  | "collect_avs"
  | "redirect"
  | "confirm_inline"
  | "poll"
  | "done";

/** What to do next with a card charge. Derived from `next_action`, never guessed. */
export interface CardStep {
  action: CardStepAction;
  chargeId: string | null;
  type?: string;
  /** Only meaningful for `collect_otp`. */
  canResend?: boolean;
  /** Only for `redirect`. */
  url?: string;
  /** Only for `collect_avs`. */
  fields?: string[];
  /** Only for `confirm_inline` (Stripe Elements rail). */
  clientSecret?: string;
  nextAction?: CompleteResponse["next_action"];
}

export interface CardChallenge {
  type: "otp" | "pin" | "avs" | "redirect";
  canResend?: boolean;
  url?: string;
  fields?: string[];
  nextAction?: CompleteResponse["next_action"];
}

export declare const AVS_FIELDS: string[];

export declare function cardChallenge(result: CompleteResponse): CardChallenge | null;

export declare function nextCardStep(
  result: CompleteResponse,
  fallback?: { chargeId?: string }
): CardStep;

export type VerificationAnswer =
  | { otp?: string; resend?: boolean }
  | { pin?: string }
  | { address?: { line1: string; city: string; state: string; postal_code: string; country?: string } }
  | string
  | null
  | undefined;

export declare function driveCardVerification(opts: {
  vault: CardVault;
  result: CompleteResponse;
  onVerification?: (challenge: CardStep & { attempt: number }) =>
    VerificationAnswer | Promise<VerificationAnswer>;
  maxAttempts?: number;
}): Promise<{ result: CompleteResponse; step: CardStep; attempts: number; reason?: string }>;

export interface PayCardOptions {
  card:
    | {
        card_number: string;
        expiry_month: number | string;
        expiry_year: number | string;
        cvv: string;
        cardholder_name?: string;
        pin?: string;
      }
    | { sealed: { encrypted_key: string; iv: string; ciphertext: string } };
  currency?: string;
  cardOptions?: { deviceInformation?: Record<string, unknown> };
  /** Called once per challenge. Return `null` to stop and hand the step back to your UI. */
  onVerification?: (challenge: CardStep & { attempt: number }) =>
    VerificationAnswer | Promise<VerificationAnswer>;
  maxVerificationAttempts?: number;
  waitForResult?: boolean;
  waitOptions?: { timeoutMs?: number; intervalMs?: number; onTick?: (status: ChargeStatus) => void };
}

export type CardPaymentResult = NormalisedPayment & {
  step: CardStep;
  verificationAttempts: number;
  verificationReason?: string;
  final?: ChargeStatus | null;
};

export declare function normalise(
  result: CompleteResponse,
  rail: { paymentMethod: string; currency: string; kind: string },
  quote?: QuoteResponse | null
): NormalisedPayment;

export declare const CARD_ACTION_NAMES: readonly string[];

/** Pure: action ids declared in one bundled chunk. */
export declare function parseActionIds(body: string): Record<string, string>;

/** Pure: chunk filenames referenced by a page or another chunk. */
export declare function parseChunkRefs(body: string): string[];

/** Crawl a checkout build for the card-vault action ids. Resolves per environment and per deploy. */
export declare function discoverCardActions(
  checkoutOrigin: string,
  token: string,
  opts?: { maxChunks?: number; concurrency?: number }
): Promise<{
  ids: Record<string, string>;
  chunks: Record<string, string>;
  crawled: number;
  missing: string[];
}>;

export declare class CheckoutSession {
  constructor(
    token: string,
    opts?: {
      apiBase?: string;
      checkoutOrigin?: string;
      /** Picks the API and checkout hosts together. Inferred from `apiBase` when omitted. */
      environment?: "live" | "sandbox";
      timeoutMs?: number;
      cardActionIds?: Record<string, string>;
    }
  );
  static fromUrl(checkoutUrl: string): CheckoutSession;

  /** Resolve this build's card-vault action ids and remember them for later calls. */
  refreshCardActions(opts?: { maxChunks?: number }): Promise<{
    ids: Record<string, string>;
    chunks: Record<string, string>;
    crawled: number;
    missing: string[];
    checkoutOrigin: string;
  }>;

  token: string;
  environment: "live" | "sandbox";
  apiBase: string;
  checkoutOrigin: string;
  cardActionIds: Record<string, string> | null;

  detail(): Promise<CheckoutDetail>;
  requirements(input: { paymentMethod: string; currency: string; paymentRail?: string }): Promise<RequirementsResponse>;
  quote(input: { paymentMethod: string; currency: string; paymentRail?: string }): Promise<QuoteResponse>;
  complete(input: { paymentMethod: string; quoteId: string; [key: string]: unknown }): Promise<CompleteResponse>;
  setAmount(amount: string | number): Promise<CheckoutDetail>;
  chargeStatus(chargeId: string): Promise<ChargeStatus>;
  authorizeMobileMoney(body: Record<string, unknown>): Promise<unknown>;
  confirmPayment(body: Record<string, unknown>): Promise<unknown>;
  pay(opts?: PayOptions): Promise<NormalisedPayment>;
  /** Pay by card and let the API drive OTP / PIN / AVS / redirect verification. */
  payCard(opts: PayCardOptions): Promise<CardPaymentResult>;
  /** Answer an OTP challenge manually; returns the next step. */
  submitOtp(input: { chargeId: string; otp?: string; resend?: boolean }):
    Promise<{ step: CardStep; raw: CompleteResponse }>;
  /** Answer an address (AVS) challenge manually. */
  submitAvs(input: {
    chargeId: string;
    address: { line1: string; city: string; state: string; postal_code: string; country?: string };
  }): Promise<{ step: CardStep; raw: CompleteResponse }>;
  /** Submit a card PIN when the issuer asks for one after the charge. */
  submitPin(input: { chargeId: string; pin: string }):
    Promise<{ step: CardStep; raw: CompleteResponse }>;
  /** The next step for a charge response, without making a request. */
  cardStep(result: CompleteResponse, fallback?: { chargeId?: string }): CardStep;
  waitForPayment(
    chargeId: string,
    opts?: { timeoutMs?: number; intervalMs?: number; onTick?: (status: ChargeStatus) => void }
  ): Promise<ChargeStatus | null>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
}

export declare class Bachs {
  constructor(opts: { secretKey: string; baseUrl?: string; timeoutMs?: number });

  secretKey: string;
  baseUrl: string;

  checkoutSessions: {
    create(body: CreateSessionInput, opts?: { idempotencyKey?: string }): Promise<CheckoutSessionObject>;
    createRaw(
      input: Omit<CreateSessionInput, "product_cart" | "pricing"> & { amount: string | number; currency: string },
      opts?: { idempotencyKey?: string }
    ): Promise<CheckoutSessionObject>;
    createCustom(
      input: Omit<CreateSessionInput, "product_cart" | "pricing"> & {
        currency: string;
        presetAmount?: string | number;
        minimumAmount?: string | number;
        maximumAmount?: string | number;
      },
      opts?: { idempotencyKey?: string }
    ): Promise<CheckoutSessionObject>;
    createFree(
      input: Omit<CreateSessionInput, "product_cart" | "pricing"> & { currency: string },
      opts?: { idempotencyKey?: string }
    ): Promise<CheckoutSessionObject>;
    get(id: string): Promise<Record<string, unknown>>;
  };

  products: {
    create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    get(id: string): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[]; pagination: Record<string, unknown> }>;
    update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    archive(id: string): Promise<Record<string, unknown>>;
    unarchive(id: string): Promise<Record<string, unknown>>;
  };

  payments: {
    get(id: string): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[]; pagination: Record<string, unknown> }>;
    charge(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  };

  refunds: {
    create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    get(id: string): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[]; pagination: Record<string, unknown> }>;
    byPayment(paymentId: string): Promise<unknown>;
  };

  customers: {
    create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    get(id: string): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[]; pagination: Record<string, unknown> }>;
    update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    portalSession(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };

  subscriptions: {
    get(id: string): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[] }>;
    update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    cancel(id: string): Promise<Record<string, unknown>>;
  };

  webhooks: {
    create(body: Record<string, unknown>): Promise<Record<string, unknown>>;
    list(query?: Record<string, string | number>): Promise<{ items: unknown[] }>;
    update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
    remove(id: string): Promise<unknown>;
    rotateSecret(id: string): Promise<Record<string, unknown>>;
    events(query?: Record<string, string | number>): Promise<{ items: unknown[] }>;
    replay(body: Record<string, unknown>): Promise<unknown>;
  };

  balances: {
    get(): Promise<Record<string, unknown>>;
    settings(): Promise<Record<string, unknown>>;
  };

  account: {
    me(): Promise<Record<string, unknown>>;
    paymentMethods(): Promise<unknown>;
    paymentRails(query?: Record<string, string>): Promise<unknown>;
    currencies(): Promise<unknown>;
    payoutCurrencies(): Promise<unknown>;
  };

  request(path: string, opts?: RequestOptions): Promise<any>;
  session(checkoutUrl: string): CheckoutSession;

  static verifyWebhook(
    rawBody: string | Buffer,
    signatureHeader: string | null | undefined,
    secret: string,
    opts?: { toleranceSeconds?: number }
  ): boolean;

  static constructEvent<T = Record<string, unknown>>(
    rawBody: string | Buffer,
    signatureHeader: string | null | undefined,
    secret: string,
    opts?: { toleranceSeconds?: number }
  ): T;
}

export interface SealCardInput {
  card_number: string;
  expiry_month: number | string;
  expiry_year: number | string;
  cvv: string;
  cardholder_name?: string;
  pin?: string;
}

export declare class CardVault {
  constructor(opts: {
    token: string;
    checkoutOrigin?: string;
    actionIds?: Record<string, string>;
    timeoutMs?: number;
  });

  static seal(
    publicKeyPem: string,
    card: SealCardInput,
    pin?: string
  ): { encrypted_key: string; iv: string; ciphertext: string };

  token: string;
  origin: string;
  actions: Record<string, string>;

  publicKey(): Promise<string>;
  action(name: string, args: unknown[]): Promise<any>;
  tokenize(card: SealCardInput): Promise<{ handle: string; brand?: string; last4?: string; collectPin: boolean }>;
  /** Tokenize a payload sealed elsewhere (browser-side), so the server never sees a PAN. */
  tokenizeSealed(
    sealed: { encrypted_key: string; iv: string; ciphertext: string }
  ): Promise<{ handle: string; brand?: string; last4?: string; collectPin: boolean }>;
  complete(input: { handle: string; quoteId: string; deviceInformation?: Record<string, unknown> }): Promise<CompleteResponse>;
  authorizeOtp(input: { chargeId: string; otp?: string; resend?: boolean }): Promise<any>;
  submitAvs(input: {
    chargeId: string;
    address: { line1: string; city: string; state: string; postal_code: string; country?: string };
  }): Promise<any>;
  authorizePin(input: { chargeId: string; pin: string }): Promise<any>;
}

export declare const KNOWN_CARD_ACTIONS: Record<string, string>;

export default Bachs;
