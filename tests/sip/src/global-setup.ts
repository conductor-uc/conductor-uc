import { removeCurlContainer, sipInfraOrSkipReason, startCurlContainer } from './run-scenario.js';

/**
 * Starts the one `curl` container the whole run's HTTP requests go through
 * (`curlContainer` in `run-scenario.ts`) and removes it when the run ends. A
 * container left attached to the compose network would stop `docker compose
 * down` from removing that network.
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if ((await sipInfraOrSkipReason()) !== undefined) return undefined;
  await startCurlContainer();
  return removeCurlContainer;
}
