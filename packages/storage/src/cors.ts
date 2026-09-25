/**
 * The one CORS rule every bucket gets (G-80). Browsers send files straight to
 * storage through presigned PUT URLs (a media upload, a brand logo) and may
 * read them back through presigned GET URLs, which are cross-origin requests
 * from the console's host to the storage host.
 *
 * - **Any origin.** The console is served from every reseller's own console
 *   hostnames, which change at any time, so listing them here would go stale.
 *   Allowing any origin is safe because the rule grants nothing by itself:
 *   every request still needs its own signed URL, and those are short-lived
 *   (05 §4: 5 minutes for GET, 15 for PUT) and name a single object.
 * - **No credentials.** S3 CORS has no credentials setting. With a `*` origin
 *   the answer carries no `Access-Control-Allow-Credentials`, so a browser
 *   refuses any credentialed request: no cookies go to the storage host. The
 *   console never sends them there anyway.
 * - **`Content-Type` only.** That is the one header the console sets on an
 *   upload (the presigned PUT signs it). `Content-Length` is set by the
 *   browser itself and needs no permission.
 * - **No exposed headers.** Nothing in the console reads a response header
 *   (such as `ETag`) from storage; the service checks the upload itself.
 * - **An hour's preflight cache**, so a batch of uploads costs one preflight.
 */
export const BROWSER_CORS_RULE = {
  AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedOrigins: ['*'],
  AllowedHeaders: ['Content-Type'],
  MaxAgeSeconds: 3600,
} as const;
