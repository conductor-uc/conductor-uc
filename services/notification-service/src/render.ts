import { readFile } from 'node:fs/promises';

import Handlebars from 'handlebars';
import mjml2html from 'mjml';

import { readableOn, safeColor, type MailBrand } from './domain/brand.js';

export type TemplateName = 'password-reset' | 'invitation';

export interface RenderInput {
  readonly template: TemplateName;
  readonly brand: MailBrand;
  /** The recipient's address. */
  readonly email: string;
  /** Their name, for a greeting. */
  readonly name?: string;
  /** The one-time link. */
  readonly link: string;
  /** How long it works, in words: "1 hour", "7 days". */
  readonly validFor: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const SUBJECTS: Record<TemplateName, string> = {
  'password-reset': 'Reset your password',
  invitation: 'You have been invited',
};

const TEMPLATE_DIR = new URL('./templates/', import.meta.url);

// Handlebars escapes `{{ }}` output by default, so a brand or user name with
// markup in it cannot inject any into the email.
const hbs = Handlebars.create();
const cache = new Map<string, HandlebarsTemplateDelegate>();
let partialsLoaded = false;

async function load(file: string): Promise<HandlebarsTemplateDelegate> {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const source = await readFile(new URL(file, TEMPLATE_DIR), 'utf8');
  // The plain-text part is not HTML, so it must not be HTML-escaped.
  const compiled = hbs.compile(source, { noEscape: file.endsWith('.txt.hbs') });
  cache.set(file, compiled);
  return compiled;
}

async function loadPartials(): Promise<void> {
  if (partialsLoaded) return;
  for (const name of ['header', 'footer']) {
    hbs.registerPartial(name, await readFile(new URL(`_${name}.mjml`, TEMPLATE_DIR), 'utf8'));
  }
  partialsLoaded = true;
}

/**
 * Renders one email with the given brand, or the neutral presentation when the
 * brand is empty (02 §5.3): no product label, no logo, a grayscale look. The
 * only names that ever appear are the reseller's own (D-002).
 */
export async function renderEmail(input: RenderInput): Promise<RenderedEmail> {
  await loadPartials();
  assertSafeLink(input.link);

  const primary = safeColor(input.brand.primaryColor);
  const supportParts = [
    input.brand.supportEmail === null ? null : `Questions? Write to ${input.brand.supportEmail}.`,
    input.brand.supportPhone === null ? null : `Phone: ${input.brand.supportPhone}.`,
    input.brand.supportUrl === null ? null : `Help: ${input.brand.supportUrl}`,
  ].filter((part): part is string => part !== null);

  const context = {
    title: SUBJECTS[input.template],
    brandName: input.brand.displayName,
    primary,
    onPrimary: readableOn(primary),
    legalFooter: input.brand.legalFooter,
    supportLine: supportParts.length === 0 ? null : supportParts.join(' '),
    email: input.email,
    name: input.name ?? input.email,
    link: input.link,
    validFor: input.validFor,
  };

  const mjmlSource = (await load(`${input.template}.mjml`))(context);
  const { html, errors } = await mjml2html(mjmlSource, { validationLevel: 'strict' });
  if (errors.length > 0) {
    throw new Error(`Template ${input.template} is not valid MJML: ${errors[0]?.message ?? ''}`);
  }
  const text = (await load(`${input.template}.txt.hbs`))(context);

  return { subject: SUBJECTS[input.template], html, text };
}

/**
 * The link goes into the HTML unescaped (escaping would turn `=` into an
 * entity in the visible copy of the address), so it must only ever be a URL
 * this service built from a validated hostname and an encoded token.
 */
const SAFE_LINK = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9_=&%.-]*)?$/;

function assertSafeLink(link: string): void {
  if (!SAFE_LINK.test(link)) throw new Error('Refusing to put an unexpected link in an email.');
}

/** "1 hour", "45 minutes", "7 days": the time left until [expiresAt], in words. */
export function validFor(expiresAt: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60));
    return `${String(days)} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
