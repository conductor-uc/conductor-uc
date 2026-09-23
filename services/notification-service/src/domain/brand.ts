/**
 * The brand an email carries (02 §5): a reseller's, or neutral. Neutral has no
 * name, no logo, and no product label, only functional wording and a grayscale
 * look (02 §5.3). The master tier is always neutral (D-002).
 */
export interface MailBrand {
  readonly displayName: string | null;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly supportEmail: string | null;
  readonly supportUrl: string | null;
  readonly supportPhone: string | null;
  readonly emailFromName: string | null;
  readonly legalFooter: string | null;
}

export const NEUTRAL_BRAND: MailBrand = {
  displayName: null,
  primaryColor: null,
  accentColor: null,
  supportEmail: null,
  supportUrl: null,
  supportPhone: null,
  emailFromName: null,
  legalFooter: null,
};

/** What org-service's `GET /internal/v1/orgs/:id/mail-brand` returns. */
export interface MailBrandResponse extends MailBrand {
  readonly neutral: boolean;
  /** The reseller's first console hostname, where links point. */
  readonly consoleHostname: string | null;
}

/** The brand to render with: neutral whenever the response says so. */
export function brandOf(response: MailBrandResponse): MailBrand {
  return response.neutral ? NEUTRAL_BRAND : response;
}

const NEUTRAL_PRIMARY = '#455a64';
const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const channel = (start: number): number => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever is more readable on [background] (WCAG AA holds for one of them). */
export function readableOn(background: string): string {
  return contrast(background, '#ffffff') >= contrast(background, '#000000') ? '#ffffff' : '#000000';
}

/** A brand color that is really a `#rrggbb`, or the neutral fallback. */
export function safeColor(value: string | null, fallback = NEUTRAL_PRIMARY): string {
  return value !== null && HEX.test(value) ? value.toLowerCase() : fallback;
}
