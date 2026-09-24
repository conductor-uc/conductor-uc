/**
 * `flow_runner.lua`'s `time_condition` node (S3-10, G-59), driven through the
 * real script under a real Lua interpreter with `session`, `freeswitch`, and
 * the `mod_curl` API stubbed. Nothing here needs FreeSWITCH: the script's
 * routing decision depends only on what telephony-config answers, so a stub
 * that answers as telephony-config would is enough to prove which branch a
 * call takes.
 *
 * Skipped, not failed, where no `lua` binary exists (see `json.test.ts`).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPTS = resolve(import.meta.dirname, '../../../telephony/freeswitch/scripts');
const JSON_LUA = join(SCRIPTS, 'json.lua');
const RUNNER = join(SCRIPTS, 'flow_runner.lua');

function findLua(): string | undefined {
  for (const candidate of ['lua', 'lua5.4', 'lua5.3', 'lua5.2', 'lua5.1', 'luajit']) {
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Not this one; try the next.
    }
  }
  return undefined;
}

const lua = findLua();
const skipReason = lua === undefined ? 'no lua interpreter on PATH' : undefined;
const workDir = mkdtempSync(join(tmpdir(), 'cuc-lua-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** How the stubbed telephony-config answers the schedule question. */
type ScheduleAnswer =
  | { readonly body: string } // a 200 with this body
  | { readonly empty: true } // a 404: mod_curl returns an empty body
  | { readonly error: string }; // mod_curl's own `-ERR ...`

interface RunOptions {
  /** The node's config: `{ scheduleId }`, or the pre-schedule `{ timezone }`. */
  readonly config: Record<string, unknown>;
  readonly answer?: ScheduleAnswer;
}

interface RunResult {
  /** The media the call played, which names the branch it took. */
  readonly played: string[];
  /** Every URL path the script asked telephony-config for. */
  readonly requests: string[];
}

/**
 * Runs the real `flow_runner.lua` against one flow: a `time_condition` whose
 * `match` plays `A-open` and whose `noMatch` plays `A-closed`.
 */
function run({ config, answer }: RunOptions): RunResult {
  const ir = {
    flowId: 'flow-1',
    versionId: 'ver-1',
    versionNumber: 1,
    ir: {
      entryPoints: { main: 'tc' },
      nodes: {
        tc: {
          id: 'tc',
          type: 'time_condition',
          config,
          ports: { match: 'open', noMatch: 'closed' },
        },
        open: { id: 'open', type: 'play', config: { mediaAssetId: 'A-open' }, ports: {} },
        closed: { id: 'closed', type: 'play', config: { mediaAssetId: 'A-closed' }, ports: {} },
      },
    },
  };
  const answerLua =
    answer === undefined
      ? 'return nil'
      : 'body' in answer
        ? `return [==[${answer.body}]==]`
        : 'empty' in answer
          ? 'return ""'
          : `return [==[${answer.error}]==]`;

  const script = join(workDir, `run-${String(Math.random()).slice(2)}.lua`);
  writeFileSync(
    script,
    `
argv = { "tenant-1", "flow-1", "main" }
local vars = { telephony_config_url = "http://telephony-config:8080", telephony_config_token = "tok" }
local played, requests, hungUp = {}, {}, false

session = {
  getVariable = function(_, name) return vars[name] end,
  ready = function() return not hungUp end,
  execute = function(_, app, arg) if app == "playback" then played[#played + 1] = arg end end,
  hangup = function() hungUp = true end,
}
freeswitch = {
  consoleLog = function(_, message) io.stderr:write(message) end,
  API = function()
    return {
      executeString = function(_, command)
        local path = command:match("^curl %S-(/fs/%S+)")
        requests[#requests + 1] = path or command
        if command:find("/ir ", 1, true) then return [==[${JSON.stringify(ir)}]==] end
        if command:find("/schedule/", 1, true) then ${answerLua} end
        return ""
      end,
    }
  end,
}

-- The script's one absolute path, and the on-disk IR cache it must not touch here.
local realDofile, realOpen = dofile, io.open
dofile = function(path)
  if path:match("json%.lua$") then return realDofile("${JSON_LUA}") end
  return realDofile(path)
end
io.open = function(path, mode)
  if path:find("/var/cache/cuc", 1, true) then return nil end
  return realOpen(path, mode)
end
io.popen = function() return nil end
os.execute = function() return true end

realDofile("${RUNNER}")
print("PLAYED " .. table.concat(played, ","))
print("REQUESTS " .. table.concat(requests, ","))
`,
  );

  const proc = execFileSync(lua!, [script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = proc.split('\n');
  const field = (name: string): string =>
    (lines.find((l) => l.startsWith(`${name} `)) ?? '').slice(name.length + 1);
  return {
    played: field('PLAYED')
      .split(',')
      .filter((s) => s.length > 0),
    requests: field('REQUESTS')
      .split(',')
      .filter((s) => s.length > 0),
  };
}

const took = (result: RunResult, media: string): boolean =>
  result.played.some((url) => url.includes(media));

describe.skipIf(skipReason !== undefined)('flow_runner.lua time_condition', () => {
  const scheduled = { scheduleId: 'sched-1' };

  it('takes match when the schedule is open', () => {
    const result = run({ config: scheduled, answer: { body: '{"open":true}' } });
    expect(took(result, 'A-open')).toBe(true);
    expect(took(result, 'A-closed')).toBe(false);
  });

  it('takes noMatch when the schedule is closed', () => {
    const result = run({ config: scheduled, answer: { body: '{"open":false}' } });
    expect(took(result, 'A-closed')).toBe(true);
    expect(took(result, 'A-open')).toBe(false);
  });

  it('asks telephony-config about this tenant and this schedule, on the call', () => {
    const result = run({ config: scheduled, answer: { body: '{"open":true}' } });
    expect(result.requests.some((r) => r === '/fs/flow/tenant-1/schedule/sched-1/open')).toBe(true);
  });

  it('treats a schedule that no longer exists (an empty 404 body) as closed', () => {
    const result = run({ config: scheduled, answer: { empty: true } });
    expect(took(result, 'A-closed')).toBe(true);
  });

  it('treats an unreachable service as closed', () => {
    const result = run({
      config: scheduled,
      answer: { error: '-ERR connection refused' },
    });
    expect(took(result, 'A-closed')).toBe(true);
  });

  it('treats an unreadable answer as closed', () => {
    for (const body of ['not json', '{"open":"yes"}', '{}', '[]']) {
      const result = run({ config: scheduled, answer: { body } });
      expect(took(result, 'A-closed'), body).toBe(true);
    }
  });

  it('keeps a flow published before schedules existed on match, without asking', () => {
    const result = run({ config: { timezone: 'America/Chicago' } });
    expect(took(result, 'A-open')).toBe(true);
    expect(result.requests.some((r) => r.includes('/schedule/'))).toBe(false);
  });
});
