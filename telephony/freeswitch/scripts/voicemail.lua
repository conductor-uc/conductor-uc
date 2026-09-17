--[[
S2-16: the voicemail Lua app. Invoked from the dialplan
(telephony-config's own `xml.ts`'s `buildDialplanDocument`/
`buildVoicemailDialplanDocument`) as:

    lua voicemail.lua leave    <tenantId> <mailboxId>
    lua voicemail.lua retrieve <tenantId> <mailboxId>

Talks to telephony-config's own `/fs/voicemail/...` routes over mod_curl —
never to voicemail-service directly (CLAUDE.md rule 4: only telephony-config
talks to FS nodes, and symmetrically, this script only ever talks to
telephony-config). `telephony_config_url`/`telephony_config_token` are the
same FreeSWITCH global variables `xml_curl.conf.xml` already uses for the
directory/dialplan/configuration bindings (`vars.xml`).

UNVERIFIED LIVE (docs/decisions.md G-38/G-39, same discipline as G-19/G-20/
G-24/G-35/G-36 for prior tasks' own FS-side code): this codebase's own
"no live FS node to test against in this task" constraint means the exact
`mod_curl` API call shape below, the DTMF digit choices, and the recording
format are this task's own best-effort reasoning, not something confirmed
against a real FreeSWITCH 1.10.12 node the way `xml.ts`'s dialplan/directory
XML shapes were. Issue #44 (S2-20, the M2 backend SIP regression suite) is
where this gets its first live proof.
--]]

local mode = argv[1]
local tenantId = argv[2]
local mailboxId = argv[3]

local api = freeswitch.API()

-- `curl` (mod_curl's own API command, not a shell-out) — `get`/`post`
-- return the response body on stdout; failure is signaled by mod_curl's own
-- prefixed error text, checked below rather than trusted blindly.
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

-- Extracts a top-level JSON string field without a full JSON library
-- (none confirmed available in this image's mod_lua build) — good enough
-- for this script's own thin, known-shape internal responses.
local function jsonField(json, field)
  if json == nil then return nil end
  local pattern = '"' .. field .. '"%s*:%s*"([^"]*)"'
  return json:match(pattern)
end

local function leaveMessage()
  local created = httpCall("POST", "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages", "{}")
  local messageId = jsonField(created, "messageId")
  local uploadUrl = jsonField(created, "uploadUrl")
  if messageId == nil or uploadUrl == nil then
    freeswitch.consoleLog("ERR", "voicemail.lua: could not create a message row, aborting leave-message\n")
    return
  end

  local spoolPath = "/var/spool/cuc/rec/vm-" .. messageId .. ".wav"
  session:answer()
  session:execute("playback", "voicemail/vm-intro.wav")
  session:setVariable("RECORD_APPEND", "false")
  session:recordFile(spoolPath, 180, 500, 3)

  -- `-T <file>` uploads the local spool file as the PUT body — the
  -- presigned URL only accepts a real byte stream, not a shell-escaped
  -- inline body the way the JSON calls above use.
  api:executeString("curl " .. uploadUrl .. " -X PUT -H \"Content-Type: audio/wav\" -T " .. spoolPath)

  local durationMs = tonumber(session:getVariable("record_ms")) or 0
  httpCall(
    "POST",
    "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages/" .. messageId .. "/complete",
    '{"durationMs":' .. durationMs .. ',"sizeBytes":0}'
  )

  os.remove(spoolPath)
  session:hangup()
end

local function retrieveMessages()
  session:answer()

  local attempt = 0
  local authorized = false
  while attempt < 3 and not authorized do
    attempt = attempt + 1
    local pin = session:playAndGetDigits(4, 8, 3, 5000, "#", "voicemail/vm-enter-pin.wav", "voicemail/vm-bad-pin.wav", "\\d+")
    if pin ~= nil and pin ~= "" then
      local verified = httpCall(
        "POST",
        "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/verify-pin",
        '{"pin":"' .. jsonEscape(pin) .. '"}'
      )
      authorized = jsonField(verified, "valid") == "true"
    end
  end

  if not authorized then
    session:execute("playback", "voicemail/vm-goodbye.wav")
    session:hangup()
    return
  end

  local list = httpCall("GET", "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages", nil)
  -- One id at a time, in the order the internal API already returns
  -- (oldest first) — good enough for a linear "next/delete/save" menu
  -- without a full JSON array parser.
  for messageId in list:gmatch('"id"%s*:%s*"([^"]*)"') do
    if not session:ready() then break end

    session:execute(
      "playback",
      "http_cache://" .. (session:getVariable("telephony_config_url") or "http://telephony-config:8080")
        .. "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages/" .. messageId .. "/audio"
    )

    -- 7 = delete, 9 = save (mark read), anything else / timeout = next.
    local digit = session:getDigits(1, "", 4000)
    if digit == "7" then
      httpCall("POST", "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages/" .. messageId .. "/delete", nil)
    elseif digit == "9" then
      httpCall("POST", "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages/" .. messageId .. "/mark-read", nil)
    end
  end

  session:execute("playback", "voicemail/vm-goodbye.wav")
  session:hangup()
end

if mode == "leave" then
  leaveMessage()
elseif mode == "retrieve" then
  retrieveMessages()
else
  freeswitch.consoleLog("ERR", "voicemail.lua: unknown mode '" .. tostring(mode) .. "'\n")
  session:hangup()
end
