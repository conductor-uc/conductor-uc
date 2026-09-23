import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingEmail {
  readonly to: string;
  /** The sender's display name, or null for none (the neutral presentation). */
  readonly fromName: string | null;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
  close(): void;
}

export interface MailerOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  /** The sender address of every email (`PLATFORM_NOREPLY_ADDRESS`). */
  readonly fromAddress: string;
}

/** A display name with control characters removed, so it cannot break a header. */
export function safeDisplayName(name: string | null): string | null {
  if (name === null) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

/** The SMTP relay client. Every email in the platform goes out through here (06). */
export function createMailer(options: MailerOptions): Mailer {
  const transport: Transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user === undefined
      ? {}
      : { auth: { user: options.user, pass: options.password ?? '' } }),
    // A dead relay should fail this attempt, so the event is retried, rather
    // than hang the consumer.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    async send(email) {
      const name = safeDisplayName(email.fromName);
      await transport.sendMail({
        from: name === null ? options.fromAddress : { name, address: options.fromAddress },
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    },
    close: () => transport.close(),
  };
}
