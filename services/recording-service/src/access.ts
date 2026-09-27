/**
 * The access client moved to `@cuc/http` (S5-09), which call-control's monitoring routes share:
 * the second service to honour a scoped grant. Re-exported so nothing here changes.
 */
export {
  AccessUnavailableError,
  createHttpAccessClient,
  type AccessClient,
  type ActorAccess,
  type HttpAccessClientOptions,
} from '@cuc/http';
