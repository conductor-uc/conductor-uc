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

UNVERIFIED LIVE (docs/decisions.md G-50, same discipline as G-38/G-41/G-43/
G-47/G-48 for prior tasks' own FS-side code): `session:execute("conference",
roomName)` with no explicit profile suffix (`mod_conference`'s own
documented default-profile behavior) and the `conference/conf-pin.wav` /
`conference/conf-bad-pin.wav` prompt paths (the stock FreeSWITCH sound
package's own conference prompts, the same package `voicemail/vm-*.wav`
already confirms is present) are this task's own best-effort reasoning, not
confirmed against a real FreeSWITCH 1.10.12 node. Issue #44 (S2-20, the M2
backend SIP regression suite) is where this gets its first live proof.
--]]

local tenantId = argv[1]
local roomId = argv[2]
local roomName = argv[3]
local pinRequired = argv[4] == "1"

local api = freeswitch.API()

-- Same `curl` API shape as `voicemail.lua`'s own `httpCall`.
local function httpCall(method, path, body)
  local baseUrl = session:getVariable("telephony_config_url") or "http://telephony-config:8080"
  local token = session:getVariable("telephony_config_token") or ""
  local url = baseUrl .. path
  local authHeader = "Authorization: Basic " .. api:executeString("shell_exec base64 -w0 <<< 'fs-node:" .. token .. "'")

  local cmd = url .. " " .. method
  cmd = cmd .. " -H " .. authHeader
  if body ~= nil then
    cmd = cmd .. " -H \"Content-Type: application/json\" -d '" .. body .. "'"
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
    local pin = session:playAndGetDigits(4, 8, 3, 5000, "#", "conference/conf-pin.wav", "conference/conf-bad-pin.wav", "\\d+")
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
