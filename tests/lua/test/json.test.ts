/**
 * Unit tests for `telephony/freeswitch/scripts/json.lua` (S2-10).
 *
 * Why these exist at all, when no other FreeSWITCH-side script in this repo
 * has tests: `json.lua` is a hand-written parser that sits directly on the
 * call-routing path, and it is the one piece of S2-10's FS-side code whose
 * correctness does *not* depend on a live FreeSWITCH process. Everything else
 * in `flow_runner.lua` (the `mod_curl` call shape, `playAndGetDigits`, the
 * bridge behavior) needs a real node and waits for issue #44 — this does not,
 * so it should not wait.
 *
 * The tests drive the real file through a real Lua interpreter rather than
 * reimplementing its logic: a parser test that shares an implementation with
 * the parser proves nothing.
 *
 * Skipped, not failed, where no `lua` binary exists — the same
 * "skip with a reason rather than fail on missing infrastructure" contract
 * `@cuc/testing`'s own `databaseOrSkipReason` establishes for the service
 * suites. FreeSWITCH ships its own Lua, so this being absent says nothing
 * about whether the script works in production.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const JSON_LUA = resolve(import.meta.dirname, '../../../telephony/freeswitch/scripts/json.lua');

/** The first `lua` on PATH, or `undefined` when none is installed. */
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

/**
 * Runs `body` with `json` already loaded, and returns what it printed.
 * `body` is Lua source, so a test asserts on real decoded values.
 */
function runLua(body: string): string {
  const script = join(workDir, `t-${String(Math.random()).slice(2)}.lua`);
  writeFileSync(script, `local json = dofile("${JSON_LUA}")\n${body}\n`);
  return execFileSync(lua!, [script], { encoding: 'utf8' }).trim();
}

describe.skipIf(skipReason !== undefined)('json.lua', () => {
  it('decodes a real compiled flow IR, including nested config and digit ports', () => {
    // The exact shape `compileGraph` emits and `/fs/flow/.../ir` serves.
    const ir = JSON.stringify({
      flowId: 'f1',
      versionId: 'v1',
      versionNumber: 3,
      ir: {
        entryPoints: { main: 'greeting', after_hours: 'ah' },
        nodes: {
          greeting: {
            id: 'greeting',
            type: 'menu',
            config: { promptMediaAssetId: 'a1', timeoutSeconds: 5, maxInvalidAttempts: 3 },
            ports: { '1': 'sales', timeout: 'vm', invalid: 'bye' },
          },
          bye: { id: 'bye', type: 'hangup', config: {}, ports: {} },
        },
      },
    });

    const output = runLua(`
      local d = json.decode([==[${ir}]==])
      print(d.versionNumber)
      print(d.ir.entryPoints.main)
      print(d.ir.nodes.greeting.config.timeoutSeconds)
      -- A DTMF port is a *numeric-looking string* key; decoding it as a
      -- number would make every menu digit lookup miss.
      print(d.ir.nodes.greeting.ports["1"])
      print(d.ir.nodes.greeting.ports.timeout)
      print(type(d.ir.nodes.bye.config))
      print(tostring(d.ir.nodes.bye.ports.next))
    `);

    expect(output.split('\n')).toEqual(['3', 'greeting', '5', 'sales', 'vm', 'table', 'nil']);
  });

  it('decodes string escapes, including a surrogate pair', () => {
    // A Lua long string (`[==[ ]==]`) so Lua itself does no escape
    // processing: the parser must be the only thing that interprets these
    // backslashes, or the test proves nothing about it. (Lua also spells
    // its own unicode escape `\u{XXXX}`, so `é` is not even valid Lua.)
    const output = runLua(String.raw`
      local d = json.decode([==[{"s":"a\"b\\c\né😀"}]==])
      print(d.s)
    `);
    expect(output).toBe('a"b\\c\né😀');
  });

  it('decodes numbers, booleans and arrays', () => {
    const output = runLua(`
      local d = json.decode('{"a":-1.5,"b":2e3,"c":0,"t":true,"f":false,"xs":[1,"two",{"k":3}]}')
      print(d.a, d.b, d.c, tostring(d.t), tostring(d.f), #d.xs, d.xs[3].k)
    `);
    expect(output.split(/\s+/)).toEqual(['-1.5', '2000.0', '0', 'true', 'false', '3', '3']);
  });

  it('keeps a null distinguishable from an absent key', () => {
    const output = runLua(`
      local d = json.decode('{"a":null}')
      print(tostring(d.a == json.null), tostring(d.b == nil))
    `);
    expect(output.split(/\s+/)).toEqual(['true', 'true']);
  });

  // Long strings throughout, for the same reason as the escape test above.
  it.each([
    ['empty input', '[==[]==]'],
    ['an HTML error page', '[==[<html>500</html>]==]'],
    ['a truncated object', String.raw`[==[{"a":]==]`],
    ['trailing content', String.raw`[==[{"a":1} oops]==]`],
    ['an unterminated string', String.raw`[==[{"a":"x]==]`],
    ['an invalid escape', String.raw`[==[{"a":"\q"}]==]`],
  ])('returns nil rather than raising on %s', (_label, literal) => {
    // This is the property `flow_runner.lua` depends on: a bad response must
    // be something it can branch on, not an error that aborts the script
    // mid-call and drops the caller.
    const output = runLua(`
      local ok, value = pcall(function() return json.decode(${literal}) end)
      print(tostring(ok), tostring(value))
    `);
    const [ok, value] = output.split(/\s+/);
    expect(ok).toBe('true');
    expect(value).toBe('nil');
  });

  it('tolerates insignificant whitespace', () => {
    const output = runLua(`
      local d = json.decode('  {  "a" : [ 1 , 2 ]  }  ')
      print(d.a[2])
    `);
    expect(output).toBe('2');
  });
});
