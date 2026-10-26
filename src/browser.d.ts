// Type definitions for bachs-checkout/browser

export declare function fetchVaultKey(checkoutOrigin?: string): Promise<string>;

export declare function sealCard(
  publicKeyPem: string,
  card: {
    card_number: string;
    expiry_month: number | string;
    expiry_year: number | string;
    cvv: string;
    cardholder_name?: string;
  },
  pin?: string
): Promise<{ encrypted_key: string; iv: string; ciphertext: string }>;

export declare function deviceInformation(): {
  java_enabled: false;
  javascript_enabled: true;
  browser_language?: string;
  color_depth?: number;
  screen_height?: number;
  screen_width?: number;
  time_zone_offset_minutes: number;
};

export declare function nextActionUrl(
  nextAction: { redirect_url?: string; redirect_to_url?: { url?: string }; payment_url?: string } | null | undefined
): string | null;

export declare function mountCardForm(opts: {
  root: HTMLFormElement | HTMLElement;
  checkoutOrigin?: string;
  onSubmit?: (sealed: { encrypted_key: string; iv: string; ciphertext: string }, device: ReturnType<typeof deviceInformation>) => unknown;
  onError?: (err: Error) => void;
}): { submit: (event?: Event) => Promise<unknown>; destroy: () => void };
