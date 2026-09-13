import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { CONFIG_FILENAME, mergeConfig, type BrandLeakConfig } from './config.js';
import { formatReport } from './report.js';
import { scan, type ScanResult } from './scan.js';

export interface RunOptions {
  readonly root: string;
  /** Overrides the config file, for tests. */
  readonly config?: BrandLeakConfig;
}

export interface RunResult {
  readonly result: ScanResult;
  readonly report: string;
  /** 0 when clean, 1 when anything was found. */
  readonly exitCode: number;
}

/**
 * Reads `brand-leak.config.json` from `root` when present, merged over the
 * defaults.
 *
 * Deny rules are additive, so a deployment adds its operator name without being
 * able to quietly drop the codebase-name rule.
 */
export function loadConfig(root: string): BrandLeakConfig {
  const file = path.join(root, CONFIG_FILENAME);
  if (!existsSync(file)) return mergeConfig({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${CONFIG_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must contain a JSON object.`);
  }
  return mergeConfig(parsed);
}

/** Scans and formats, returning the exit code rather than calling `process.exit`. */
export function runBrandLeak(options: RunOptions): RunResult {
  const config = options.config ?? loadConfig(options.root);
  const result = scan({ root: options.root, config });

  const emptyIsFatal = config.failOnEmptyInclude === true && result.emptyIncludes.length > 0;
  const exitCode = result.findings.length > 0 || emptyIsFatal ? 1 : 0;

  return { result, report: formatReport(result), exitCode };
}
