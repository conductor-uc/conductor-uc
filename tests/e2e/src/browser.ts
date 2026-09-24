import { Secret, TOTP } from 'otpauth';

export interface Reply<T = unknown> {
  readonly status: number;
  readonly json: T;
  readonly text: string;
}

/**
 * A tiny browser for the console's API: it keeps cookies, asks for
 * cookie-only refresh transport the way the console does, and holds the
 * access token in memory.
 */
export class Browser {
  readonly jar = new Map<string, string>();
  access: string | undefined;

  constructor(private readonly base: string) {}

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean } = {},
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-refresh-transport': 'cookie',
    };
    if (this.jar.size > 0) {
      headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (options.auth !== false && this.access !== undefined) {
      headers['authorization'] = `Bearer ${this.access}`;
    }
    const response = await fetch(this.base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const [key = '', value = ''] = pair.split('=');
      const expired = attributes.some((a) => a.toLowerCase() === 'max-age=0');
      if (expired || value === '') this.jar.delete(key);
      else this.jar.set(key, value);
    }
    const text = await response.text();
    return { status: response.status, json: parseJson(text) as T, text };
  }
}

/** The current authenticator code for a base32 secret. */
export function totp(secret: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

interface MailSummary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
}

export interface Mail {
  readonly From: { readonly Name: string; readonly Address: string };
  readonly Text: string;
  readonly HTML: string;
}

/** Mail caught by Mailpit for [address], waiting up to [waitMs] for some to arrive. */
export async function mailTo(mailBase: string, address: string, waitMs = 15_000): Promise<Mail[]> {
  const end = Date.now() + waitMs;
  for (;;) {
    const list = (await (await fetch(`${mailBase}/api/v1/messages?limit=200`)).json()) as {
      messages: MailSummary[];
    };
    const mine = list.messages.filter((m) => m.To.some((t) => t.Address === address));
    if (mine.length > 0 || Date.now() > end) {
      return Promise.all(
        mine.map(
          async (m) => (await (await fetch(`${mailBase}/api/v1/message/${m.ID}`)).json()) as Mail,
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The one-time token in a link like `/reset/confirm?token=…`. */
export function tokenIn(mail: Mail, path: string): string | undefined {
  return new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(mail.Text)?.[1];
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
