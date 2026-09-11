/** One invalid or missing environment variable. */
export interface ConfigIssue {
  /** The environment variable name, e.g. `HTTP_PORT`. */
  readonly variable: string;
  /** Why it was rejected, e.g. `must be integer`. Never contains the value. */
  readonly message: string;
}

/**
 * Thrown when the environment does not satisfy the schema.
 *
 * The message lists every offending variable by name and reason. It never
 * includes the offending value: environment variables routinely hold secrets
 * (07 §5), and a startup crash is exactly the kind of thing that ends up in a
 * log aggregator.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(ConfigError.format(issues));
    this.issues = issues;
  }

  private static format(issues: readonly ConfigIssue[]): string {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    return `Invalid configuration (${issues.length} problem${
      issues.length === 1 ? '' : 's'
    }):\n${lines.join('\n')}`;
  }
}
