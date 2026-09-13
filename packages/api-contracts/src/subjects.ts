/**
 * Event domains, one per JetStream stream (05 §5).
 *
 * The stream name is the domain uppercased, and each stream captures
 * `{domain}.>`.
 */
export const EVENT_DOMAINS = [
  'org',
  'identity',
  'pbx',
  'trunk',
  'callflow',
  'call',
  'cdr',
  'recording',
  'voicemail',
  'sms',
  'fax',
  'audit',
] as const;

export type EventDomain = (typeof EVENT_DOMAINS)[number];

/** JetStream stream names, in the same order. */
export type StreamName = Uppercase<EventDomain>;

const DOMAIN_SET = new Set<string>(EVENT_DOMAINS);

/** One lowercase snake_case subject segment. */
const SEGMENT = /^[a-z][a-z0-9_]*$/;

export class InvalidSubjectError extends Error {
  override readonly name = 'InvalidSubjectError';

  constructor(subject: string, reason: string) {
    super(`Invalid event subject '${subject}': ${reason}.`);
  }
}

export interface ParsedSubject {
  readonly domain: EventDomain;
  readonly stream: StreamName;
  /** The segments after the domain, e.g. `['extension', 'created']`. */
  readonly rest: readonly string[];
}

/**
 * Parses `{domain}.{entity}.{verb}` (05 §5).
 *
 * Two segments after the domain is the canonical shape, but the documented set
 * includes `call.lost`, which has one. Both are accepted rather than pretending
 * the convention is uniform; anything beyond three is rejected, because a deeper
 * subject is almost always a filter pattern that leaked into an event type.
 */
export function parseSubject(subject: string): ParsedSubject {
  const segments = subject.split('.');

  if (segments.length < 2) throw new InvalidSubjectError(subject, 'expected at least domain.verb');
  if (segments.length > 3)
    throw new InvalidSubjectError(subject, 'expected at most three segments');

  const [domain, ...rest] = segments;

  if (domain === undefined || !DOMAIN_SET.has(domain)) {
    throw new InvalidSubjectError(
      subject,
      `unknown domain '${String(domain)}'; expected one of ${EVENT_DOMAINS.join(', ')}`,
    );
  }
  for (const segment of rest) {
    if (!SEGMENT.test(segment)) {
      throw new InvalidSubjectError(subject, `segment '${segment}' is not lowercase snake_case`);
    }
  }

  return {
    domain: domain as EventDomain,
    stream: streamFor(domain as EventDomain),
    rest,
  };
}

/** True when `subject` is a well-formed event type. */
export function isEventSubject(subject: string): boolean {
  try {
    parseSubject(subject);
    return true;
  } catch {
    return false;
  }
}

/** The stream a subject belongs to. */
export function streamFor(domain: EventDomain): StreamName {
  return domain.toUpperCase() as StreamName;
}

/** The subject filter a stream captures. */
export function streamSubjects(domain: EventDomain): string {
  return `${domain}.>`;
}

/** Every stream a deployment provisions, with the filter each captures. */
export function allStreams(): readonly { name: StreamName; subjects: readonly string[] }[] {
  return EVENT_DOMAINS.map((domain) => ({
    name: streamFor(domain),
    subjects: [streamSubjects(domain)],
  }));
}
