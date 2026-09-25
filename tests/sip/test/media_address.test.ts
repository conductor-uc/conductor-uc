import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { fsCliOn, sipInfraOrSkipReason, sipTestEnv } from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

/** The value of one `sofia status profile internal` line, e.g. `Ext-RTP-IP`. */
function field(status: string, name: string): string | undefined {
  return new RegExp(`^${name}\\s+(\\S+)`, 'm').exec(status)?.[1];
}

async function containerEnv(container: string, name: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    container,
    '--format',
    '{{json .Config.Env}}',
  ]);
  const entry = (JSON.parse(stdout) as string[]).find((e) => e.startsWith(`${name}=`));
  const value = entry?.slice(name.length + 1);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * G-114: the address FreeSWITCH advertises for audio. With no
 * `FS_EXTERNAL_RTP_IP` it is the node's own interface address; with one, that
 * address, while signalling stays on the interface address (OpenSIPs must
 * keep seeing one source address). Checked on every node, whatever the stack
 * sets, so a stack started with the variable on one node covers both cases.
 */
describe.skipIf(skipReason !== undefined)('FreeSWITCH media address (live)', () => {
  for (const container of sipTestEnv().freeswitchContainers) {
    it(`${container}: advertises FS_EXTERNAL_RTP_IP for audio when set, its own address otherwise`, async () => {
      const status = await fsCliOn(container, 'sofia status profile internal');
      const rtpIp = field(status, 'RTP-IP');
      const extRtpIp = field(status, 'Ext-RTP-IP');
      const sipIp = field(status, 'SIP-IP');
      const extSipIp = field(status, 'Ext-SIP-IP');
      expect(rtpIp, status).toBeDefined();
      expect(sipIp, status).toBeDefined();

      const configured = await containerEnv(container, 'FS_EXTERNAL_RTP_IP');
      expect(extRtpIp).toBe(configured ?? rtpIp);
      // Signalling is never moved to the public address.
      expect(extSipIp).toBe(sipIp);
    });
  }
});
