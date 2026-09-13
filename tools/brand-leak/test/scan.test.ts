import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeConfig } from '../src/config.js';
import { formatReport } from '../src/report.js';
import { loadConfig, runBrandLeak } from '../src/run.js';
import { scan } from '../src/scan.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'brand-leak-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file into the fixture repository, creating parents. */
function write(relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** The real defaults, minus the self-exclusion of the scanner's own directory. */
function config(overrides: Parameters<typeof mergeConfig>[0] = {}) {
  return mergeConfig({ allow: ['**/node_modules/**'], ...overrides });
}

describe('the acceptance criterion', () => {
  it('fails when the codebase name is added to the console shell', () => {
    write(
      'apps/console/web/index.html',
      '<!doctype html>\n<html>\n<head><title>ConductorUC</title></head>\n</html>\n',
    );

    const { exitCode, result, report } = runBrandLeak({ root, config: config() });

    expect(exitCode).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: 'apps/console/web/index.html',
      line: 3,
      ruleId: 'codebase-name',
      match: 'ConductorUC',
    });
    expect(report).toContain('apps/console/web/index.html');
    expect(report).toContain('3:');
  });

  it('passes on the same file once the name is gone', () => {
    write(
      'apps/console/web/index.html',
      '<!doctype html>\n<html>\n<head><title>Sign in</title></head>\n</html>\n',
    );

    expect(runBrandLeak({ root, config: config() }).exitCode).toBe(0);
  });
});

describe('what counts as the codebase name', () => {
  it.each([
    'ConductorUC',
    'conductoruc',
    'conductor-uc',
    'conductor_uc',
    'Conductor UC',
    'CONDUCTORUC',
  ])('catches %s', (variant) => {
    write('apps/console/web/index.html', `<p>${variant}</p>`);

    expect(scan({ root, config: config() }).findings).toHaveLength(1);
  });

  it('does not fire on unrelated words that merely contain "uc"', () => {
    write('apps/console/web/index.html', '<p>Conduct a survey. Much success. Reduce.</p>');

    expect(scan({ root, config: config() }).findings).toEqual([]);
  });

  it('catches the Flutter scaffolding string', () => {
    write('apps/console/web/manifest.json', '{"description": "A new Flutter project."}');

    const findings = scan({
      root,
      config: config({ include: ['apps/console/web/**'] }),
    }).findings;

    expect(findings[0]?.ruleId).toBe('flutter-template');
  });

  it('reports every hit on a line, not just the first', () => {
    write('apps/console/web/index.html', '<p>ConductorUC and conductor-uc</p>');

    expect(scan({ root, config: config() }).findings).toHaveLength(2);
  });

  it('reports every hit in a file, across lines', () => {
    write('apps/console/web/index.html', 'ConductorUC\nfine\nconductoruc\n');

    const findings = scan({ root, config: config() }).findings;

    expect(findings.map((finding) => finding.line)).toEqual([1, 3]);
  });
});

describe('which surfaces are scanned', () => {
  it('scans the console web shell and Dart sources', () => {
    write('apps/console/web/index.html', 'ConductorUC');
    write('apps/console/lib/main.dart', "const title = 'ConductorUC';");

    expect(scan({ root, config: config() }).findings).toHaveLength(2);
  });

  it('scans email and telephony templates', () => {
    write('services/notification-service/templates/invite.mjml', '<mj-text>ConductorUC</mj-text>');
    write(
      'telephony/freeswitch/sip_profile.xml',
      '<param name="user-agent-string" value="ConductorUC"/>',
    );

    const files = scan({ root, config: config() }).findings.map((finding) => finding.file);

    expect(files).toContain('services/notification-service/templates/invite.mjml');
    expect(files).toContain('telephony/freeswitch/sip_profile.xml');
  });

  it('scans published API descriptions wherever they sit', () => {
    write('services/org-service/openapi.json', '{"info":{"title":"ConductorUC API"}}');

    expect(scan({ root, config: config() }).findings).toHaveLength(1);
  });

  it('scans built console output', () => {
    write('apps/console/build/web/main.dart.js', 'var t="ConductorUC";');

    expect(scan({ root, config: config() }).findings).toHaveLength(1);
  });

  it('leaves source code alone, where the name is allowed', () => {
    // 02 §5.2: the name may appear in source, package names, image names,
    // internal logs, and developer docs.
    write('packages/http/src/server.ts', "const codebase = 'conductor-uc';");
    write('package.json', '{"name":"conductor-uc"}');
    write('docs/sad.md', 'ConductorUC is the codebase name.');
    write('README.md', '# conductor-uc');

    expect(scan({ root, config: config() }).findings).toEqual([]);
  });

  it('honours the allow-list inside a scanned directory', () => {
    write('apps/console/lib/generated.g.dart', "const s = 'ConductorUC';");
    write('apps/console/lib/main.dart', "const s = 'ConductorUC';");

    const files = scan({
      root,
      config: mergeConfig({ allow: ['**/*.g.dart'] }),
    }).findings.map((finding) => finding.file);

    expect(files).toEqual(['apps/console/lib/main.dart']);
  });

  it('skips binary assets rather than reading them as text', () => {
    write('apps/console/web/favicon.ico', 'ConductorUC');
    write('apps/console/web/logo.png', 'ConductorUC');

    expect(scan({ root, config: config() }).findings).toEqual([]);
  });

  it('skips a file above the size limit and says so', () => {
    write('apps/console/web/huge.js', `${'x'.repeat(200)}ConductorUC`);

    const result = scan({ root, config: config({ maxFileBytes: 50 }) });

    expect(result.findings).toEqual([]);
    expect(result.skippedLarge[0]?.file).toBe('apps/console/web/huge.js');
    expect(formatReport(result)).toContain('exceeds the size limit');
  });

  it('counts a file once when two include globs match it', () => {
    write('apps/console/web/openapi.json', '{"x":1}');

    // Matched by both `apps/console/web/**` and `**/openapi.json`.
    expect(scan({ root, config: config() }).scanned).toBe(1);
  });
});

describe('surfaces that matched nothing', () => {
  it('reports them, because a moved surface is silently unchecked', () => {
    write('apps/console/web/index.html', '<p>Sign in</p>');

    const result = scan({ root, config: config() });

    expect(result.emptyIncludes).toContain('telephony/**/*.xml');
    expect(formatReport(result)).toContain('matched no files');
  });

  it('passes anyway by default, since most surfaces arrive in later stages', () => {
    write('apps/console/web/index.html', '<p>Sign in</p>');

    expect(runBrandLeak({ root, config: config() }).exitCode).toBe(0);
  });

  it('fails when a deployment opts in with failOnEmptyInclude', () => {
    write('apps/console/web/index.html', '<p>Sign in</p>');

    expect(runBrandLeak({ root, config: config({ failOnEmptyInclude: true }) }).exitCode).toBe(1);
  });
});

describe('configuration', () => {
  it('uses the defaults when no config file is present', () => {
    expect(loadConfig(root).deny.map((rule) => rule.id)).toContain('codebase-name');
  });

  it('adds a deployment operator name to the deny-list', () => {
    write(
      'brand-leak.config.json',
      JSON.stringify({
        deny: [{ id: 'operator-name', pattern: 'Acme Telecom', hint: 'Operator name.' }],
      }),
    );
    write('apps/console/web/index.html', '<p>Acme Telecom</p>');

    const loaded = loadConfig(root);

    expect(loaded.deny.map((rule) => rule.id)).toContain('operator-name');
    expect(runBrandLeak({ root }).exitCode).toBe(1);
  });

  it('cannot drop the built-in rules by supplying its own deny list', () => {
    write(
      'brand-leak.config.json',
      JSON.stringify({ deny: [{ id: 'other', pattern: 'zzz', hint: 'x' }] }),
    );

    expect(loadConfig(root).deny.map((rule) => rule.id)).toContain('codebase-name');
  });

  it('rejects a config file that is not valid JSON', () => {
    write('brand-leak.config.json', '{ not json');

    expect(() => loadConfig(root)).toThrow(/not valid JSON/);
  });

  it('rejects a config file that is not an object', () => {
    write('brand-leak.config.json', '[]');

    expect(() => loadConfig(root)).toThrow(/must contain a JSON object/);
  });
});

describe('the report', () => {
  it('says what to do, not just what is wrong', () => {
    write('apps/console/web/index.html', '<title>ConductorUC</title>');

    const report = runBrandLeak({ root, config: config() }).report;

    expect(report).toContain('The Master tier is completely unbranded');
    expect(report).toContain('must not appear on a user-facing');
  });

  it('reports a clean run with the number of files checked', () => {
    write('apps/console/web/index.html', '<p>Sign in</p>');

    expect(runBrandLeak({ root, config: config() }).report).toContain('No brand leaks. 1 file');
  });
});
