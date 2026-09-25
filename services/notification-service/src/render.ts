import { readFile } from 'node:fs/promises';

import Handlebars from 'handlebars';
import mjml2html from 'mjml';

import { readableOn, safeColor, type MailBrand } from './domain/brand.js';

export type TemplateName =
  'password-reset' | 'invitation' | 'mfa-reset' | 'mfa-reset-admin' | 'voicemail';

export interface RenderInput {
  readonly template: TemplateName;
  readonly brand: MailBrand;
  /** The recipient's address. */
  readonly email: string;
  /** Their name, for a greeting. */
  readonly name?: string;
  /** The link: a one-time one, or for the `mfa-reset` notices the plain sign-in page. */
  readonly link: string;
  /** How long a one-time link works, in words: "1 hour", "7 days". */
  readonly validFor?: string;
  /** Required for `mfa-reset-admin`: the person whose two-step verification was reset. */
  readonly about?: { readonly name: string; readonly email: string };
  /** Required for the `voicemail` template. */
  readonly voicemail?: VoicemailSummary;
}

/** How the recording relates to the email: it is attached, was not asked for, or was too big to attach. */
export type VoicemailAudio = 'attached' | 'not_requested' | 'too_large';

/** A new voicemail message, as the `voicemail` template shows it. All of it is private-class data. */
export interface VoicemailSummary {
  readonly callerName: string | null;
  readonly callerNumber: string | null;
  readonly receivedAt: Date;
  readonly durationMs: number | null;
  readonly audio: VoicemailAudio;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const SUBJECTS: Record<TemplateName, string> = {
  'password-reset': 'Reset your password',
  invitation: 'You have been invited',
  'mfa-reset': 'Your two-step verification was reset',
  'mfa-reset-admin': 'Two-step verification was reset for someone in your organization',
  voicemail: 'New voicemail',
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

  if (input.template === 'mfa-reset-admin' && input.about === undefined) {
    throw new Error('The mfa-reset-admin template needs the person it is about.');
  }
  const voicemail = voicemailContext(input);
  const subject = voicemail === undefined ? SUBJECTS[input.template] : voicemail.subject;

  const context = {
    ...(voicemail === undefined ? {} : voicemail.fields),
    title: subject,
    brandName: input.brand.displayName,
    primary,
    onPrimary: readableOn(primary),
    legalFooter: input.brand.legalFooter,
    supportLine: supportParts.length === 0 ? null : supportParts.join(' '),
    email: input.email,
    name: input.name ?? input.email,
    link: input.link,
    validFor: input.validFor ?? '',
    aboutName: input.about?.name ?? '',
    aboutEmail: input.about?.email ?? '',
  };

  const mjmlSource = (await load(`${input.template}.mjml`))(context);
  const { html, errors } = await mjml2html(mjmlSource, { validationLevel: 'strict' });
  if (errors.length > 0) {
    throw new Error(`Template ${input.template} is not valid MJML: ${errors[0]?.message ?? ''}`);
  }
  const text = (await load(`${input.template}.txt.hbs`))(context);

  return { subject, html, text };
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

/** Caller ID is set by whoever placed the call, so it is untrusted text: no control characters, and short. */
function cleanCaller(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? null : cleaned.slice(0, 64);
}

/** "0:42", "12:05": a duration in minutes and seconds. */
export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  const total = Math.max(0, Math.round(durationMs / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

/** "Thu, 24 Sep 2026 19:20 UTC": the same wording in every locale, and unambiguous. */
export function formatReceivedAt(date: Date): string {
  return `${date.toUTCString().replace(/:\d\d GMT$/, '')} UTC`;
}

function voicemailContext(
  input: RenderInput,
): { subject: string; fields: Record<string, unknown> } | undefined {
  if (input.template !== 'voicemail') return undefined;
  const summary = input.voicemail;
  if (summary === undefined) throw new Error('The voicemail template needs a voicemail summary.');

  const name = cleanCaller(summary.callerName);
  const number = cleanCaller(summary.callerNumber);
  const caller = name ?? number ?? 'an unknown caller';
  return {
    subject: `New voicemail from ${caller}`,
    fields: {
      callerName: name,
      callerNumber: number,
      caller,
      // The name with the number after it when both are known, otherwise whichever there is.
      callerLine: name !== null && number !== null ? `${name} (${number})` : caller,
      receivedAt: formatReceivedAt(summary.receivedAt),
      duration: formatDuration(summary.durationMs),
      audioAttached: summary.audio === 'attached',
      audioTooLarge: summary.audio === 'too_large',
    },
  };
}
