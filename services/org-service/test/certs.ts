import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A short-lived self-signed certificate for [names], and its key, made with `openssl`. */
export function makeCertificate(names: string[], days = 60): { certificate: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'org-certs-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        String(days),
        '-subj',
        `/CN=${names[0] ?? 'test'}`,
        '-addext',
        `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      certificate: readFileSync(join(dir, 'c.pem'), 'utf8'),
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
