import type { ScanResult } from './scan.js';

/**
 * Formats findings for a terminal and a CI log.
 *
 * Grouped by file and prefixed `file:line:column`, so an editor and a reviewer
 * can both jump straight to it.
 */
export function formatReport(result: ScanResult): string {
  const lines: string[] = [];

  if (result.findings.length > 0) {
    const byFile = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
      byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
    }

    lines.push(
      `Brand leak: ${String(result.findings.length)} forbidden string${
        result.findings.length === 1 ? '' : 's'
      } in ${String(byFile.size)} file${byFile.size === 1 ? '' : 's'}.`,
      '',
    );

    for (const [file, findings] of byFile) {
      lines.push(file);
      for (const finding of findings) {
        lines.push(
          `  ${String(finding.line)}:${String(finding.column)}  ${finding.ruleId}  found "${finding.match}"`,
          `    ${finding.excerpt}`,
          `    ${finding.hint}`,
        );
      }
      lines.push('');
    }

    lines.push(
      'The Master tier is completely unbranded (D-002). Only reseller brands, or the',
      'neutral presentation, may appear on a user-facing or network-visible surface.',
      '',
    );
  }

  for (const { file, bytes } of result.skippedLarge) {
    lines.push(`Warning: ${file} skipped, ${String(bytes)} bytes exceeds the size limit.`);
  }

  if (result.emptyIncludes.length > 0) {
    lines.push(
      'Warning: these configured surfaces matched no files, so nothing was checked for them:',
      ...result.emptyIncludes.map((pattern) => `  ${pattern}`),
      'That is expected until the stage that creates them; set failOnEmptyInclude once it has.',
      '',
    );
  }

  if (result.findings.length === 0) {
    lines.push(`No brand leaks. ${String(result.scanned)} file(s) checked.`);
  }

  return lines.join('\n');
}
