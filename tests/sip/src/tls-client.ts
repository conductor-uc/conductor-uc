import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

/**
 * A minimal SIP client over TLS, for tests: REGISTER with digest authentication.
 *
 * SIPp is what the other tests use, but the SIPp image this suite ships is from
 * 2017 and offers only TLS 1.0, which the edge correctly refuses (TLS 1.2 is its
 * floor). This speaks TLS 1.2 or later itself and needs nothing else installed.
 */

export interface TlsRegisterOptions {
  /** Where OpenSIPs' TLS port is published. */
  readonly host: string;
  readonly port: number;
  /** The SIP domain: the request URI, and the name sent for SNI. */
  readonly domain: string;
  readonly user: string;
  readonly password: string;
}

export interface TlsRegisterResult {
  /** The status of each response, in order: normally 401 then 200. */
  readonly statuses: readonly number[];
  /** The TLS version the connection negotiated. */
  readonly protocol: string | null;
}

const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

/** Reads `key="value"` and `key=value` pairs from a Digest challenge. */
function parseChallenge(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) {
    const key = match[1];
    if (key !== undefined) fields[key.toLowerCase()] = match[3] ?? match[2] ?? '';
  }
  return fields;
}

export function registerOverTls(options: TlsRegisterOptions): Promise<TlsRegisterResult> {
  const { host, port, domain, user, password } = options;
  const callId = `${randomBytes(8).toString('hex')}@tls-test`;
  const fromTag = randomBytes(4).toString('hex');

  return new Promise((resolve, reject) => {
    const statuses: number[] = [];
    let buffer = '';
    let cseq = 1;

    const socket = connect(
      // The development certificate is self-signed; its names are checked by
      // their own test, this one is about registering over the connection.
      { host, port, servername: domain, rejectUnauthorized: false, minVersion: 'TLSv1.2' },
      () => send(),
    );
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer over TLS after ${String(statuses.length)} response(s)`));
    }, 10_000);
    const finish = (): void => {
      clearTimeout(timer);
      const protocol = socket.getProtocol();
      socket.end();
      resolve({ statuses, protocol });
    };

    function send(authorization?: string): void {
      const local = `${socket.localAddress ?? '127.0.0.1'}:${String(socket.localPort ?? 0)}`;
      const lines = [
        `REGISTER sip:${domain} SIP/2.0`,
        `Via: SIP/2.0/TLS ${local};branch=z9hG4bK${randomBytes(6).toString('hex')};rport`,
        `From: <sip:${user}@${domain}>;tag=${fromTag}`,
        `To: <sip:${user}@${domain}>`,
        `Call-ID: ${callId}`,
        `CSeq: ${String(cseq)} REGISTER`,
        `Contact: <sip:${user}@${local};transport=tls>`,
        'Max-Forwards: 70',
        'Expires: 60',
        ...(authorization === undefined ? [] : [`Authorization: ${authorization}`]),
        'Content-Length: 0',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    }

    function answerChallenge(header: string): void {
      const c = parseChallenge(header);
      const realm = c['realm'] ?? domain;
      const nonce = c['nonce'] ?? '';
      const uri = `sip:${domain}`;
      const ha1 = md5(`${user}:${realm}:${password}`);
      const ha2 = md5(`REGISTER:${uri}`);
      const qop = c['qop']?.split(',')[0]?.trim();
      const cnonce = randomBytes(6).toString('hex');
      const nc = '00000001';
      const response =
        qop === undefined
          ? md5(`${ha1}:${nonce}:${ha2}`)
          : md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      const parts = [
        `username="${user}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `response="${response}"`,
        'algorithm=MD5',
        ...(qop === undefined ? [] : [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`]),
      ];
      cseq += 1;
      send(`Digest ${parts.join(', ')}`);
    }

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Every response here has no body, so a blank line ends it.
      for (let end = buffer.indexOf('\r\n\r\n'); end !== -1; end = buffer.indexOf('\r\n\r\n')) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 4);
        const status = Number(/^SIP\/2\.0 (\d{3})/.exec(message)?.[1] ?? 0);
        if (status === 100) continue;
        statuses.push(status);
        const challenge = /^WWW-Authenticate:\s*(.+)$/im.exec(message)?.[1];
        if (status === 401 && challenge !== undefined && statuses.length === 1) {
          answerChallenge(challenge);
        } else {
          finish();
          return;
        }
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
