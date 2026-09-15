/** One forbidden string or pattern. */
export interface DenyRule {
  /** Stable id, reported with each finding, e.g. `codebase-name`. */
  readonly id: string;
  /** JavaScript regular expression source. */
  readonly pattern: string;
  /** Defaults to `gi`. `g` is added if missing, since every hit matters. */
  readonly flags?: string;
  /** Shown with the finding, so the fix is obvious from the failure alone. */
  readonly hint: string;
}

export interface BrandLeakConfig {
  /**
   * Globs the scanner reads, relative to the repository root.
   *
   * This is an include-list rather than "everything minus exceptions" on
   * purpose. The codebase name is allowed in source, package names, image names,
   * internal logs, and developer docs (02 §5.2), so a scan-everything default
   * would be all false positives and would be silenced within a week.
   */
  readonly include: readonly string[];
  /** Globs skipped inside `include`, for code-only files that live among assets. */
  readonly allow: readonly string[];
  readonly deny: readonly DenyRule[];
  /**
   * Fail when an `include` glob matches no files.
   *
   * A surface that has moved or been renamed stops being scanned silently, and
   * the run stays green while covering nothing. Default false, because most of
   * these directories do not exist until the stage that creates them.
   */
  readonly failOnEmptyInclude?: boolean;
  /** Binary and generated files never worth reading. */
  readonly skipExtensions?: readonly string[];
  /** Files above this size are skipped, with a warning. */
  readonly maxFileBytes?: number;
}

/**
 * The deny-list from 02 §5.5.
 *
 * `operator-name` is deliberately absent: there is no operator name in this
 * repository, and a deployment that has one adds it through its own config file
 * rather than by editing this default.
 */
export const DEFAULT_DENY: readonly DenyRule[] = [
  {
    id: 'codebase-name',
    // Catches ConductorUC, conductor-uc, conductoruc, conductor_uc, "Conductor UC".
    pattern: 'conductor[\\s_-]?uc',
    flags: 'gi',
    hint: 'The codebase name must not appear on a user-facing or network-visible surface (02 §5.1-5.2).',
  },
  {
    id: 'flutter-template',
    pattern: 'A new Flutter project',
    flags: 'gi',
    hint: 'Flutter scaffolding left in place. Replace it with a functional description, or remove it.',
  },
  {
    id: 'flutter-default-title',
    pattern: '<title>\\s*console\\s*</title>|flutter_application|example\\.com/flutter',
    flags: 'gi',
    hint: 'Flutter default metadata. The console title is set at runtime from the resolved brand (02 §5.3).',
  },
];

/**
 * The surfaces from the checklist in 02 §5.5 that live in this repository.
 *
 * Several of these directories do not exist yet; they are listed now so the
 * surface is covered the day it appears, rather than remembered later.
 */
export const DEFAULT_INCLUDE: readonly string[] = [
  // The console: its web shell carries Flutter's own defaults, and its Dart
  // sources carry every user-visible string.
  'apps/console/web/**',
  'apps/console/lib/**',
  'apps/console/pubspec.yaml',
  // Built console output, when a build has run.
  'apps/console/build/web/**',
  // Email templates (S3).
  'services/*/templates/**',
  'services/notification-service/**/*.mjml',
  'services/notification-service/**/*.hbs',
  // Telephony config templates: SIP User-Agent/Server headers and SDP identity.
  'telephony/**/*.xml',
  'telephony/**/*.cfg',
  // OpenSIPs' own source-controlled artifact is the *template* rendered at
  // container start (S1-11) — `*.cfg` alone never matches it.
  'telephony/**/*.cfg.template',
  'telephony/**/*.conf',
  'telephony/**/*.lua',
  'telephony/**/*.tpl',
  // Published API descriptions.
  '**/openapi.json',
  '**/openapi.yaml',
];

/** Code-only paths that may legitimately contain the codebase name (02 §5.2). */
export const DEFAULT_ALLOW: readonly string[] = [
  '**/node_modules/**',
  '**/.dart_tool/**',
  '**/*.g.dart',
  '**/*.freezed.dart',
  // The scanner's own fixtures contain the forbidden strings by design.
  'tools/brand-leak/**',
];

export const DEFAULT_SKIP_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.opus',
  '.mp4',
  '.pdf',
  '.zip',
  '.gz',
  '.wasm',
  '.so',
  '.dylib',
  '.dll',
];

export const DEFAULT_CONFIG: BrandLeakConfig = {
  include: DEFAULT_INCLUDE,
  allow: DEFAULT_ALLOW,
  deny: DEFAULT_DENY,
  failOnEmptyInclude: false,
  skipExtensions: DEFAULT_SKIP_EXTENSIONS,
  maxFileBytes: 2 * 1024 * 1024,
};

/** Config file read from the repository root when present. */
export const CONFIG_FILENAME = 'brand-leak.config.json';

/**
 * Merges a partial config over the defaults.
 *
 * `deny` is **added to**, never replaced: a deployment adds its operator name
 * without being able to quietly drop the codebase-name rule. `include` and
 * `allow` are replaced, because those are genuinely deployment-shaped.
 */
export function mergeConfig(overrides: Partial<BrandLeakConfig>): BrandLeakConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    deny: [...DEFAULT_DENY, ...(overrides.deny ?? [])],
  };
}
