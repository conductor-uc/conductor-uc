--[[
S2-15: the conference-room Lua app. Invoked from the dialplan
(telephony-config's own `xml.ts`'s `buildConferenceDialplanDocument`) as:

    lua conference.lua <tenantId> <roomId> <roomName> <pinRequired:0|1>

Talks to telephony-config's own `/fs/conference-rooms/...` route over
mod_curl — never to pbx-config-service directly (CLAUDE.md rule 4: only
telephony-config talks to FS nodes, and symmetrically, this script only ever
talks to telephony-config), the same "thin proxy" shape `voicemail.lua`
already establishes for its own `/fs/voicemail/...` calls.
`telephony_config_url`/`telephony_config_token` are the same FreeSWITCH
global variables `voicemail.lua`/`xml_curl.conf.xml` already use.

Every response this script reads is a flat, known-shape `{"valid":true}` —
`jsonField`'s own `string.match` is enough (`json.lua`'s own comment on why
`voicemail.lua` gets away with the same thing), so no `json.lua` decode is
needed here.

CONFIRMED LIVE (docs/decisions.md G-50, S2-20): `session:execute("conference",
roomName)` with no explicit profile suffix does join the `default` profile —
but only because `autoload_configs/conference.conf.xml` now defines one
statically; `mod_conference` fails the call outright if that file is
missing entirely, not merely unconfigured.

Also confirmed live, and fixed: the original `conference/conf-pin.wav` /
`conference/conf-bad-pin.wav` prompt paths below were a real, load-bearing
bug, not just an unconfirmed guess — this image ships no FreeSWITCH sound
package at all (see the Dockerfile's own comment), so `playAndGetDigits`
hit a missing-file error and returned immediately, every one of its 3
internal tries exhausted within milliseconds, without ever actually
listening for a caller's DTMF. A PIN-required room hung up on *every*
caller instantly, right PIN or wrong, not merely a rejected wrong one.
Fixed the same way G-48 already fixed `valet_hold_music` for the same
underlying cause: `silence_stream://1000`, a synthetic, always-resolvable
stream, in place of both file paths — `playAndGetDigits` now genuinely
waits out its own timeout for real digits.

A third bug, found later (S2-20, while debugging `voicemail.lua`'s own
identical `httpCall`), turned out to be two compounding bugs, both fixed:
(a) `shell_exec` — this script's original way of base64-encoding a Basic
auth header — is not a registered FS API command in this image at all
(confirmed directly: `show api` has no such entry); (b) even fixed with a
real base64 encoder, `mod_curl`'s own `curl` API command turned out not to
be a curl-CLI lookalike at all — `-H`/`-d` flags do not exist, and neither
does reliably chaining more than one of its own real options together (its
own usage string documents `append_headers <n:v>[|append_headers <n:v>]`
as valid; confirmed live, with a raw packet capture, that it is not — the
literal `|...` text ends up appended to the first option's own value).
Since `Basic <token>` always has a space right after `Basic`, and that
command's argument parser breaks on any space in a header value, *no*
Basic-auth header could ever survive it intact, base64 or not. Every
`verify-pin` call this script ever made sent a malformed/truncated
Authorization header and got a 401 back, meaning `authorized` could never
become `true` regardless of whether the PIN itself was right — a bug the
wrong-PIN test below never could have caught (a broken auth header and a
genuinely wrong PIN produce the identical "always rejected" outcome).
Fixed by dropping Basic auth for this script entirely in favor of a
single, space-free `X-Fs-Node-Token: <token>` header (`append_headers`'s
one reliable shape) — see `authorized()` in `fs.routes.ts` for the
matching server-side change. Verified end to end, including a genuinely
*correct* PIN this time (`tests/sip/test/conference.test.ts`).
--]]

local tenantId = argv[1]
local roomId = argv[2]
local roomName = argv[3]
local pinRequired = argv[4] == "1"

local api = freeswitch.API()

-- Same `curl` API shape as `voicemail.lua`'s own `httpCall` — see that
-- script's own doc comment for the full detail on why this is a single
-- `append_headers` and no explicit Content-Type.
local function httpCall(method, path, body)
  local baseUrl = session:getVariable("telephony_config_url") or "http://telephony-config:8080"
  local token = session:getVariable("telephony_config_token") or ""
  local url = baseUrl .. path

  local cmd = url .. " append_headers X-Fs-Node-Token:" .. token .. " " .. method
  if body ~= nil then
    cmd = cmd .. " " .. body
  end
  return api:executeString("curl " .. cmd)
end

local function jsonEscape(value)
  if value == nil then return "" end
  return tostring(value):gsub('\\', '\\\\'):gsub('"', '\\"')
end

local function jsonField(json, field)
  if json == nil then return nil end
  local pattern = '"' .. field .. '"%s*:%s*"?([^,"}]*)"?'
  return json:match(pattern)
end

session:answer()

local authorized = true
if pinRequired then
  authorized = false
  local attempt = 0
  while attempt < 3 and not authorized do
    attempt = attempt + 1
    local pin = session:playAndGetDigits(4, 8, 3, 5000, "#", "silence_stream://1000", "silence_stream://1000", "\\d+")
    if pin ~= nil and pin ~= "" then
      local verified = httpCall(
        "POST",
        "/fs/conference-rooms/" .. tenantId .. "/" .. roomId .. "/verify-pin",
        '{"pin":"' .. jsonEscape(pin) .. '"}'
      )
      authorized = jsonField(verified, "valid") == "true"
    end
  end
end

if not authorized then
  session:hangup()
  return
end

session:execute("conference", roomName)
