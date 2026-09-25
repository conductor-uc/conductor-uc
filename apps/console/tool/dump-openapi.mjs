#!/usr/bin/env node
// Builds the OpenAPI document the console client is generated from, straight
// from the services' own route definitions (resolves G-54's drift risk).
//
// Each service's `register*Routes` function only touches its repo inside a
// request handler, so registering it with a stub repo and asking Fastify for
// the document needs no database, bus, or network. Run `pnpm build` first;
// this reads the compiled `dist`.
//
//   node apps/console/tool/dump-openapi.mjs
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (path) => import(pathToFileURL(resolve(root, path)).href);

const { createServer } = await load('packages/http/dist/index.js');

// [service dir, route module, exported register function, extra stub args]
const SOURCES = [
  ['identity-service', 'auth', 'registerAuthRoutes', 1],
  ['identity-service', 'users', 'registerUserRoutes', 5],
  ['identity-service', 'roles', 'registerRoleRoutes', 4],
  ['identity-service', 'audit', 'registerAuditRoutes', 2],
  ['identity-service', 'me', 'registerMeRoutes', 2],
  ['org-service', 'brand', 'registerBrandRoutes', 4],
  ['org-service', 'org', 'registerOrgRoutes', 2],
  ['org-service', 'domain', 'registerDomainRoutes', 2],
  ['org-service', 'certificate', 'registerCertificateRoutes', 1],
  ['org-service', 'acme-settings', 'registerAcmeSettingsRoutes', 3],
  ['org-service', 'network', 'registerNetworkRoutes', 3],
  ['trunk-service', 'trunk', 'registerTrunkRoutes', 3],
  ['pbx-config-service', 'extension', 'registerExtensionRoutes', 2],
  ['pbx-config-service', 'sip-endpoint', 'registerSipEndpointRoutes', 2],
  ['pbx-config-service', 'device', 'registerDeviceRoutes', 3],
  ['pbx-config-service', 'did', 'registerDidRoutes', 1],
  ['pbx-config-service', 'emergency-location', 'registerEmergencyLocationRoutes', 1],
  ['pbx-config-service', 'media-asset', 'registerMediaAssetRoutes', 1],
  ['pbx-config-service', 'ring-group', 'registerRingGroupRoutes', 1],
  ['pbx-config-service', 'queue', 'registerQueueRoutes', 2],
  ['pbx-config-service', 'agent', 'registerAgentRoutes', 1],
  ['pbx-config-service', 'parking-lot', 'registerParkingLotRoutes', 1],
  ['pbx-config-service', 'conference-room', 'registerConferenceRoomRoutes', 1],
  ['pbx-config-service', 'schedule', 'registerScheduleRoutes', 1],
  ['pbx-config-service', 'call-handling', 'registerCallHandlingRoutes', 2],
  ['pbx-config-service', 'me', 'registerMeRoutes', 3],
  ['callflow-service', 'flow', 'registerFlowRoutes', 1],
  ['trunk-service', 'trunk', 'registerTrunkRoutes', 3],
  ['voicemail-service', 'mailbox', 'registerMailboxRoutes', 3],
  ['voicemail-service', 'me', 'registerMeRoutes', 5],
  ['trunk-service', 'outbound-route', 'registerOutboundRouteRoutes', 1],
  ['trunk-service', 'emergency-route', 'registerEmergencyRouteRoutes', 1],
  ['cdr-service', 'cdr', 'registerCdrRoutes', 3],
  ['recording-service', 'recording', 'registerRecordingRoutes', 1],
  ['recording-service', 'policy', 'registerPolicyRoutes', 1],
  ['cdr-service', 'me', 'registerMeRoutes', 2],
  // A leading `@` names a module directly under `src/` rather than `src/routes/`.
  ['api-gateway', '@platform-health', 'registerPlatformHealth', 1],
];

const merged = {
  openapi: '3.1.0',
  info: { title: 'Console API', version: '0.1.0' },
  servers: [{ url: '/' }],
  paths: {},
  components: { schemas: {} },
};

for (const [service, module, register, stubs] of SOURCES) {
  const app = await createServer({ serviceName: service, logLevel: 'silent' });
  const routes = await load(
    module.startsWith('@')
      ? `services/${service}/dist/src/${module.slice(1)}.js`
      : `services/${service}/dist/src/routes/${module}.routes.js`,
  );
  // Some registers take a bus as their last argument; a stub is enough.
  routes[register](app, ...Array.from({ length: stubs }, () => ({})));
  await app.ready();
  const spec = app.swagger();
  Object.assign(merged.paths, spec.paths);
  Object.assign(merged.components.schemas, spec.components?.schemas ?? {});
  await app.close();
}

// Fastify assigns no operation ids; without them the generated client's methods
// are named after the URL. Derive `listExtensions`, `getExtension`,
// `createQueueTier`, `publishFlow`, ... from the method and path.
const singular = (word) =>
  word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') ? word.slice(0, -1) : word;
const pascal = (kebab) => kebab.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
// Routes whose path does not follow the resource conventions below.
const OVERRIDES = {
  'post /v1/auth/login': 'login',
  'post /v1/auth/mfa/enroll/confirm': 'confirmMfaEnrollment',
  'post /v1/auth/mfa/verify': 'verifyMfa',
  'post /v1/auth/refresh': 'refreshTokens',
  'post /v1/auth/logout': 'logout',
  'get /v1/public/brand': 'getPublicBrand',
  'get /v1/resellers/{id}/brand': 'getBrand',
  'get /v1/orgs/{orgId}/me': 'getMyAccess',
  'get /v1/orgs/{orgId}/audit-events': 'listAuditEvents',
  'get /v1/platform/health': 'getPlatformHealth',
  'get /v1/platform/certificates': 'listPlatformCertificates',
  'get /v1/resellers/{id}/certificates': 'listResellerCertificates',
  'get /v1/platform/acme-settings': 'getAcmeSettings',
  'put /v1/platform/acme-settings': 'saveAcmeSettings',
  'get /v1/platform/network-settings': 'getNetworkSettings',
  'put /v1/platform/network-settings': 'saveNetworkSettings',
  'get /v1/resellers/{id}/dns-records': 'listResellerDnsRecords',
  'get /v1/tenants/{tenantId}/flows/{id}/versions/{versionNumber}': 'getFlowVersion',
  'get /v1/tenants/{tenantId}/extensions/{extensionId}/call-handling': 'getCallHandling',
  'put /v1/tenants/{tenantId}/extensions/{extensionId}/call-handling': 'saveCallHandling',
  'post /v1/resellers/{id}/brand/assets': 'uploadBrandAsset',
  'put /v1/tenants/{tenantId}/voicemail/mailboxes/{id}/email-settings': 'saveMailboxEmailSettings',
  'post /v1/tenants/{tenantId}/voicemail/mailboxes/{id}/reset-pin': 'resetMailboxPin',
  'post /v1/tenants/{tenantId}/voicemail/mailboxes/{id}/greeting/presign': 'presignMailboxGreeting',
  'post /v1/tenants/{tenantId}/voicemail/mailboxes/{id}/greeting/complete': 'completeMailboxGreeting',
  'get /v1/tenants/{tenantId}/voicemail/mailboxes/{id}/messages/{messageId}/play-url': 'getMessagePlayUrl',
  'get /v1/tenants/{tenantId}/recordings/{id}/play-url': 'getRecordingPlayUrl',
  'get /v1/tenants/{tenantId}/recordings/{id}/download-url': 'getRecordingDownloadUrl',
  'get /v1/tenants/{tenantId}/recording-settings': 'getRecordingSettings',
  'get /v1/tenants/{tenantId}/media-assets/{id}/download-url': 'getMediaAssetDownloadUrl',
  'put /v1/tenants/{tenantId}/recording-settings': 'saveRecordingSettings',
  // End-user self-service (parity 1e): a person's own extension, voicemail and history.
  'get /v1/tenants/{tenantId}/me/extension': 'getMyExtension',
  'get /v1/tenants/{tenantId}/me/directory': 'listMyDirectory',
  'get /v1/tenants/{tenantId}/me/call-handling': 'getMyCallHandling',
  'put /v1/tenants/{tenantId}/me/call-handling': 'saveMyCallHandling',
  'get /v1/tenants/{tenantId}/me/voicemail': 'getMyVoicemail',
  'get /v1/tenants/{tenantId}/me/voicemail/messages': 'listMyVoicemailMessages',
  'get /v1/tenants/{tenantId}/me/voicemail/messages/{messageId}/play-url': 'getMyMessagePlayUrl',
  'post /v1/tenants/{tenantId}/me/voicemail/messages/{messageId}/read': 'markMyMessageRead',
  'delete /v1/tenants/{tenantId}/me/voicemail/messages/{messageId}': 'deleteMyMessage',
  'post /v1/tenants/{tenantId}/me/voicemail/reset-pin': 'resetMyVoicemailPin',
  'put /v1/tenants/{tenantId}/me/voicemail/email-settings': 'saveMyVoicemailEmailSettings',
  'get /v1/tenants/{tenantId}/me/calls': 'listMyCalls',
};
const VERBS = { get: 'get', post: 'create', put: 'save', patch: 'update', delete: 'delete' };

// Path segments that name an action on one resource rather than a collection.
const ACTIONS = new Set(['reveal', 'finalize', 'validate', 'publish', 'rollback', 'suspend', 'resume', 'verify']);

for (const [path, item] of Object.entries(merged.paths)) {
  const segments = path.split('/').filter((s) => s && !s.startsWith('{') && s !== 'v1');
  const last = segments.at(-1);
  const endsInParam = path.endsWith('}');
  const action = ACTIONS.has(last) ? last : null;
  // Under `/v1/tenants/{tenantId}/`, `tenants` only scopes the request; the
  // rest name resources, outermost first. Elsewhere (`/v1/resellers/{id}/...`)
  // every segment names a resource.
  const scoped = path.startsWith('/v1/tenants/{tenantId}/');
  const resources = segments.slice(scoped ? 1 : 0, action === null ? undefined : -1);
  const resource = resources.at(-1);
  for (const [method, operation] of Object.entries(item)) {
    let id;
    if (action !== null) {
      id = `${action}${pascal(singular(resource))}`;
    } else if (resource === 'flows' && last === 'draft') {
      id = 'saveFlowDraft';
    } else if (method === 'get' && !endsInParam) {
      id = `list${pascal(resource)}`;
    } else {
      id = `${VERBS[method]}${pascal(singular(resource))}`;
    }
    if (last === 'versions') id = 'listFlowVersions';
    if (last === 'draft') id = 'saveFlowDraft';
    operation.operationId = OVERRIDES[`${method} ${path}`] ?? id;
    operation.tags = [pascal(resources[0])];
  }
}

// TypeBox writes a nullable as `anyOf: [X, {type: null}]`; the generator copes
// far better with `type: [X, 'null']`.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== 'object') return node;
  const copy = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, normalize(v)]));
  const any = copy.anyOf;
  if (Array.isArray(any) && any.length === 2) {
    const nullIndex = any.findIndex((a) => a.type === 'null');
    const other = any[1 - nullIndex];
    if (nullIndex !== -1 && typeof other.type === 'string') {
      const { anyOf, ...rest } = copy;
      return { ...rest, ...other, type: [other.type, 'null'] };
    }
  }
  return copy;
}
merged.paths = normalize(merged.paths);

const seen = new Set();
for (const item of Object.values(merged.paths)) {
  for (const { operationId } of Object.values(item)) {
    if (seen.has(operationId)) throw new Error(`duplicate operationId ${operationId}: add an OVERRIDES entry`);
    seen.add(operationId);
  }
}

const out = resolve(root, 'apps/console/api/openapi.json');
await writeFile(out, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`${Object.keys(merged.paths).length} paths -> ${out}`);
