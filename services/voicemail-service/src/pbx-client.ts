/**
 * Asks pbx-config-service which extension belongs to a person
 * (`GET /internal/v1/tenants/:tenantId/users/:userId/extension`, parity 1e).
 * Voicemail-service keeps mailboxes by extension id and knows nothing about
 * people, so this is how the self-service routes turn the signed actor id into
 * "my mailbox". Same shared bearer token as every internal call (07 §1).
 */

export interface UserExtension {
  readonly extensionId: string;
  readonly number: string;
}

/** `undefined` when the person has no extension. Throws {@link PbxClientError} when pbx-config-service cannot be reached. */
export type UserExtensionLookup = (
  tenantId: string,
  userId: string,
) => Promise<UserExtension | undefined>;

export class PbxClientError extends Error {
  override readonly name = 'PbxClientError';
}

export interface PbxClientOptions {
  /** e.g. `http://pbx-config-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createPbxClient(options: PbxClientOptions): {
  readonly userExtension: UserExtensionLookup;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async userExtension(tenantId, userId) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/extension`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxClientError(
          `pbx-config-service rejected the extension lookup (${String(response.status)}).`,
        );
      }
      const body = (await response.json()) as UserExtension;
      return { extensionId: body.extensionId, number: body.number };
    },
  };
}
