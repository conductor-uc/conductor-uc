import { ProblemError } from '@cuc/http';

import type {
  InvalidEmailSettingsError,
  InvalidExtensionIdError,
  InvalidPinError,
} from '../domain/mailbox.js';
import type { MailboxAlreadyExistsError, MailboxNotFoundError } from '../repo/mailbox.repo.js';
import type { MessageNotFoundError } from '../repo/message.repo.js';

/**
 * The problems every voicemail route answers with, one stable code per
 * condition (S9-02, D-018). Clients translate by `code`, so a condition
 * raised in more than one place is built here, once.
 */

export function internalTokenInvalid(): ProblemError {
  return ProblemError.unauthorized('A valid internal service token is required.', {
    code: 'internal_token_invalid',
  });
}

export function mailboxNotFound(error?: MailboxNotFoundError): ProblemError {
  if (error === undefined) {
    return ProblemError.notFound('No mailbox with that id.', { code: 'mailbox_not_found' });
  }
  return ProblemError.notFound(error.message, {
    code: 'mailbox_not_found',
    params: { mailboxId: error.mailboxId },
  });
}

export function mailboxAlreadyExists(error: MailboxAlreadyExistsError): ProblemError {
  return ProblemError.conflict(error.message, {
    code: 'mailbox_already_exists',
    params: { extensionId: error.extensionId },
  });
}

/** The internal lookup by extension; `me.routes.ts` says the same to the mailbox's owner. */
export function extensionHasNoMailbox(): ProblemError {
  return ProblemError.notFound('That extension has no mailbox.', { code: 'no_mailbox' });
}

/** A message that does not exist, or is not in the mailbox the path names. */
export function messageNotFound(detail: string): ProblemError;
export function messageNotFound(error: MessageNotFoundError): ProblemError;
export function messageNotFound(from: string | MessageNotFoundError): ProblemError {
  if (typeof from === 'string') return ProblemError.notFound(from, { code: 'message_not_found' });
  return ProblemError.notFound(from.message, {
    code: 'message_not_found',
    params: { messageId: from.messageId },
  });
}

/** No message with that id in that mailbox whose audio has arrived. */
export function readyMessageNotFound(): ProblemError {
  return ProblemError.notFound('No ready message with that id in that mailbox.', {
    code: 'ready_message_not_found',
  });
}

/** The PIN's value is never a param: only the rule it broke. */
export function pinInvalid(error: InvalidPinError): ProblemError {
  return ProblemError.badRequest(error.message, { code: 'mailbox_pin_invalid' });
}

export function extensionIdRequired(error: InvalidExtensionIdError): ProblemError {
  return ProblemError.badRequest(error.message, { code: 'mailbox_extension_id_required' });
}

export function emailSettingsInvalid(error: InvalidEmailSettingsError): ProblemError {
  return ProblemError.badRequest(error.message, { code: error.code });
}
