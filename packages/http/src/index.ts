export { registerHardRules } from './authz.js';
export {
  buildRequestContext,
  INTERNAL_CONTEXT_HEADERS,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_SIGNATURE_MAX_AGE_MS,
  parseTraceparent,
  REQUEST_ID_HEADER,
  signInternalHeaders,
  TRACEPARENT_HEADER,
  type ActorType,
  type ContextOptions,
  type OrgType,
  type RequestContext,
} from './context.js';
export { httpEnvSchema } from './config.js';
export {
  DATA_CLASSES,
  isDataClass,
  type DataClass,
  type Permission,
  type RegisteredRoute,
  type RouteContract,
} from './contract.js';
export {
  registerHealthRoutes,
  type HealthOptions,
  type ReadinessCheck,
  type ReadinessResult,
} from './health.js';
export {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  ProblemError,
  registerProblemHandlers,
  toProblem,
  type Problem,
  type ProblemFieldError,
  type ProblemOptions,
} from './problem.js';
export { registerRouteContractGuard, RouteContractError } from './route-guard.js';
export { createServer, type CreateServerOptions, type OpenApiOptions } from './server.js';
export type { Server } from './server-type.js';

import './types.js';

// Re-exported so route schemas are written without a direct TypeBox
// dependency, keeping the workspace on one TypeBox version.
export { Type } from 'typebox';
export type { Static, TObject, TSchema } from 'typebox';
