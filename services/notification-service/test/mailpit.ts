/**
 * Mailpit is the SMTP catcher the local stack and CI both run (S0-05). These
 * tests send through its SMTP port and read what arrived over its HTTP API, so
 * they exercise the real relay path rather than a fake transport.
 *
 * As with the database and NATS helpers, `REQUIRE_SMTP_TESTS=1` (set in CI)
 * turns "Mailpit is not reachable" from a skip into a failure.
 */
export const MAILPIT_URL = process.env['TEST_MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
export const SMTP_HOST = process.env['TEST_SMTP_HOST'] ?? '127.0.0.1';
export const SMTP_PORT = Number(process.env['TEST_SMTP_PORT'] ?? '1025');

export async function mailpitOrSkipReason(): Promise<string | undefined> {
  try {
    const response = await fetch(`${MAILPIT_URL}/api/v1/info`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) return undefined;
    return `Mailpit answered ${String(response.status)}`;
  } catch {
    const reason = `Mailpit is not reachable at ${MAILPIT_URL}`;
    if (process.env['REQUIRE_SMTP_TESTS'] === '1') {
      throw new Error(`${reason}, and REQUIRE_SMTP_TESTS=1.`);
    }
    return reason;
  }
}

export interface CaughtEmail {
  readonly from: { readonly name: string; readonly address: string };
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface Summary {
  ID: string;
  To: { Address: string }[];
}

interface Full {
  From: { Name: string; Address: string };
  To: { Address: string }[];
  Subject: string;
  HTML: string;
  Text: string;
}

export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
}

/** Every message that arrived for [recipient], waiting briefly for delivery. */
export async function emailsTo(recipient: string, waitMs = 3000): Promise<CaughtEmail[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`)).json()) as {
      messages: Summary[];
    };
    const mine = list.messages.filter((m) => m.To.some((t) => t.Address === recipient));
    if (mine.length > 0 || Date.now() >= deadline) {
      return Promise.all(
        mine.map(async (m) => {
          const full = (await (
            await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}`)
          ).json()) as Full;
          return {
            from: { name: full.From.Name, address: full.From.Address },
            to: full.To.map((t) => t.Address),
            subject: full.Subject,
            html: full.HTML,
            text: full.Text,
          };
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
