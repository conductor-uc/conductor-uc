import { resolveTxt } from 'node:dns/promises';

/**
 * The one DNS operation base-domain verification needs, as an interface —
 * so a test injects a fake resolver instead of needing real DNS (or a real
 * domain under the tester's control) to prove the verification flow.
 */
export interface DnsResolver {
  /** Resolves TXT records for `hostname`. Each record is an array of the strings it was split into. */
  resolveTxt(hostname: string): Promise<string[][]>;
}

/** The real resolver, backed by Node's `dns/promises`. */
export function nodeDnsResolver(): DnsResolver {
  return { resolveTxt };
}
