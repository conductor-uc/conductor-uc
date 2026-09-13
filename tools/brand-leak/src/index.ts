export {
  CONFIG_FILENAME,
  DEFAULT_ALLOW,
  DEFAULT_CONFIG,
  DEFAULT_DENY,
  DEFAULT_INCLUDE,
  DEFAULT_SKIP_EXTENSIONS,
  mergeConfig,
  type BrandLeakConfig,
  type DenyRule,
} from './config.js';
export { formatReport } from './report.js';
export { scan, type Finding, type ScanOptions, type ScanResult } from './scan.js';
export { loadConfig, runBrandLeak, type RunOptions, type RunResult } from './run.js';
