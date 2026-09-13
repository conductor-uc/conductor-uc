import { globSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type { BrandLeakConfig, DenyRule } from './config.js';

/** One forbidden string found in one place. */
export interface Finding {
  /** Repository-relative, with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly ruleId: string;
  /** The text that matched, verbatim. */
  readonly match: string;
  /** The line it was found on, trimmed and truncated. */
  readonly excerpt: string;
  readonly hint: string;
}

export interface ScanResult {
  readonly findings: readonly Finding[];
  /** Files actually read. Directories, allowed paths, and skips are not counted. */
  readonly scanned: number;
  /** `include` globs that matched nothing — a surface may have moved. */
  readonly emptyIncludes: readonly string[];
  /** Files skipped for being too large, with their sizes. */
  readonly skippedLarge: readonly { file: string; bytes: number }[];
}

export interface ScanOptions {
  readonly root: string;
  readonly config: BrandLeakConfig;
}

/**
 * Scans the configured surfaces for forbidden strings (02 §5.5).
 *
 * Every deny rule is applied to every line, so one file reports every problem it
 * has rather than only the first.
 */
export function scan(options: ScanOptions): ScanResult {
  const { root, config } = options;
  const matchers = config.deny.map(compile);
  const skipExtensions = new Set(config.skipExtensions ?? []);
  const maxBytes = config.maxFileBytes ?? 2 * 1024 * 1024;

  const findings: Finding[] = [];
  const emptyIncludes: string[] = [];
  const skippedLarge: { file: string; bytes: number }[] = [];
  // A path can be produced by more than one include glob, and globSync yields
  // directories as well as files.
  const seen = new Set<string>();
  let scanned = 0;

  for (const pattern of config.include) {
    const matches = globSync(pattern, { cwd: root }).map(toPosix);
    if (matches.length === 0) {
      emptyIncludes.push(pattern);
      continue;
    }

    for (const relative of matches) {
      if (seen.has(relative)) continue;
      seen.add(relative);

      if (isAllowed(relative, config.allow)) continue;
      if (skipExtensions.has(path.extname(relative).toLowerCase())) continue;

      const absolute = path.join(root, relative);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.size > maxBytes) {
        skippedLarge.push({ file: relative, bytes: stats.size });
        continue;
      }

      findings.push(...scanFile(absolute, relative, matchers));
      scanned += 1;
    }
  }

  return { findings, scanned, emptyIncludes, skippedLarge };
}

interface CompiledRule {
  readonly rule: DenyRule;
  readonly regex: RegExp;
}

function compile(rule: DenyRule): CompiledRule {
  const flags = rule.flags ?? 'gi';
  // Without `g`, `exec` never advances and a second hit on a line is missed.
  return { rule, regex: new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`) };
}

function scanFile(absolute: string, relative: string, rules: readonly CompiledRule[]): Finding[] {
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    // Unreadable or not valid UTF-8: nothing a text scan can say about it.
    return [];
  }

  const findings: Finding[] = [];
  const lines = text.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const { rule, regex } of rules) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        findings.push({
          file: relative,
          line: index + 1,
          column: match.index + 1,
          ruleId: rule.id,
          match: match[0],
          excerpt: excerpt(line),
          hint: rule.hint,
        });
        // A zero-length match would spin forever.
        if (match[0] === '') regex.lastIndex += 1;
      }
    }
  }
  return findings;
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function isAllowed(relative: string, allow: readonly string[]): boolean {
  return allow.some((pattern) => path.matchesGlob(relative, pattern));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
