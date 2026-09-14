/**
 * WCAG 2.x contrast (02 §5.3: "Must meet WCAG AA contrast"), applied to a
 * reseller's `primary_color`/`accent_color` pair — the two colors a brand
 * submits together, and the two most likely to end up next to each other in
 * the console (an accent on a primary-colored surface, or vice versa).
 */

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class InvalidColorError extends Error {
  override readonly name = 'InvalidColorError';
}

export class InsufficientContrastError extends Error {
  override readonly name = 'InsufficientContrastError';
}

/** WCAG AA for normal text (1.4.3) — the standard "AA contrast" bar. */
export const WCAG_AA_RATIO = 4.5;

/** Validates `#rrggbb`. Rejects short (`#fff`) and alpha (`#rrggbbaa`) forms — one canonical shape. */
export function validateHexColor(value: string): string {
  if (!HEX_PATTERN.test(value)) {
    throw new InvalidColorError(`'${value}' is not a 6-digit hex color, e.g. '#1a2b3c'.`);
  }
  return value;
}

/** Relative luminance (WCAG 2.x §1.4.3), 0 (black) to 1 (white). */
function relativeLuminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two `#rrggbb` colors, from 1 (identical) to 21 (black on white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lighter = Math.max(relativeLuminance(hexA), relativeLuminance(hexB));
  const darker = Math.min(relativeLuminance(hexA), relativeLuminance(hexB));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Throws {@link InsufficientContrastError} unless the pair meets {@link WCAG_AA_RATIO}. */
export function assertAccessiblePair(primaryColor: string, accentColor: string): void {
  const ratio = contrastRatio(primaryColor, accentColor);
  if (ratio < WCAG_AA_RATIO) {
    throw new InsufficientContrastError(
      `primaryColor/accentColor contrast is ${ratio.toFixed(2)}:1; WCAG AA requires at least ${String(WCAG_AA_RATIO)}:1.`,
    );
  }
}
