import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import type { SigningKey, VerificationKey } from '../repo/signing-key.repo.js';

export type TicketType = 'mfa_enroll' | 'mfa_verify';

/**
 * The claim shape for an MFA ticket — deliberately nothing like
 * {@link AccessTokenClaims}. No `org`, `ot`, `roles`, `perms`, or `sid`: a
 * ticket authenticates nothing on its own, it only lets the holder attempt
 * one specific next step, and looking structurally different from a real
 * access token is what stops it being mistaken for one by any code that is
 * not this file.
 */
export interface TicketClaims extends JWTPayload {
  readonly sub: string;
  readonly typ: TicketType;
  /** The pending MFA factor this ticket is for. */
  readonly fid: string;
}

const ALG = 'EdDSA';

export class InvalidTicketError extends Error {
  override readonly name = 'InvalidTicketError';
}

export async function signTicket(
  key: SigningKey,
  claims: { sub: string; typ: TicketType; fid: string },
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ typ: claims.typ, fid: claims.fid })
    .setProtectedHeader({ alg: ALG, kid: key.id })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key.privateKey);
}

/** Verifies a ticket and checks it is the expected {@link TicketType}. */
export async function verifyTicket(
  ticket: string,
  keys: readonly VerificationKey[],
  expected: TicketType,
): Promise<TicketClaims> {
  let payload: JWTPayload;
  try {
    const header = decodeHeader(ticket);
    const key = keys.find((candidate) => candidate.id === header.kid);
    if (key === undefined) throw new InvalidTicketError('Unknown signing key.');
    ({ payload } = await jwtVerify(ticket, key.publicKey, { algorithms: [ALG] }));
  } catch (error) {
    if (error instanceof InvalidTicketError) throw error;
    throw new InvalidTicketError('The ticket is malformed, expired, or does not verify.');
  }

  if (
    payload.typ !== expected ||
    typeof payload.sub !== 'string' ||
    typeof payload.fid !== 'string'
  ) {
    throw new InvalidTicketError(`Expected a '${expected}' ticket.`);
  }
  return payload as TicketClaims;
}

function decodeHeader(token: string): { kid?: string } {
  const [headerPart] = token.split('.');
  if (headerPart === undefined) throw new InvalidTicketError('Malformed ticket.');
  return JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { kid?: string };
}
