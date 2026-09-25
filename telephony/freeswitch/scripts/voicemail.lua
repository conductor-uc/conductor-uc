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

The `mod_curl` API call shape below is confirmed live (S2-20, G-41 — see
the auth/Content-Type paragraph further down).

S5-16: this script never uploads audio. `mod_curl` cannot PUT a local file
(the old upload step used curl-CLI flags it does not have, and reported
`"sizeBytes":0`, so messages were listed with nothing in storage).
`leaveMessage` now only creates the message row (which names the spool
file, `vm-<messageId>.wav`), records the caller into the node spool, and
hangs up. The file stays there: the node uploader sidecar (the same one
that delivers call recordings) waits for it to settle, uploads it to
voicemail-service, which checks size and MD5 against storage before the
message is listed, and only then deletes it. Nothing durable stays on the
node (CLAUDE.md rule 5). A caller who hangs up before speaking leaves a
header-only file, which the uploader reports as `empty_file`; no file at
all leaves the row `pending`, which voicemail-service's pending sweep
marks failed. Pending messages are never listed either way.

The `voicemail/vm-*.wav` prompt paths below are pre-emptively fixed, not
merely unverified: this image ships no FreeSWITCH sound package at all
(confirmed twice already this same task — G-48's `valet_hold_music`,
G-50's conference PIN prompts), and `playAndGetDigits` against a missing
prompt file returns instantly without ever listening for real digits
(G-50's own confirmed finding). `silence_stream://1000` in place of every
prompt path here applies that same fix before this script's first live
run, rather than rediscovering the identical bug a third time.

CONFIRMED LIVE (S2-20), two compounding bugs, both fixed, in how this
script's own `httpCall` authenticated: (a) `shell_exec` — its original way
of base64-encoding a `Basic <token>` auth header — is not a registered FS
API command in this image at all (confirmed directly: `show api` has no
such entry, and calling it returns `-ERR shell_exec ... Command not
found!`); (b) even with a real base64 encoder in place of the shell-out,
`mod_curl`'s own `curl` API command turned out not to be a curl-CLI
lookalike at all — no `-H`/`-d` flags exist, and its own real options
(`append_headers <name:value>` for setting a header) cannot reliably be
combined with anything else in this FreeSWITCH build, confirmed live with
a raw packet capture: chaining a second option after the first via `|`
(the exact shape `mod_curl`'s own usage string documents as valid) just
appends that literal text onto the first option's own value instead.
Since `Basic <token>` always has a space right after `Basic`, and that
argument parser truncates any value at its first space regardless, no
Basic-auth header could ever have survived it intact — base64 or not,
quoted or not. Every single `httpCall` this script ever made — leaving a
message, verifying a retrieval PIN, listing/deleting/marking messages —
sent a malformed/truncated Authorization header and got a 401 back from
telephony-config, meaning voicemail was completely non-functional, not
merely unconfirmed. Fixed by dropping Basic auth here entirely in favor
of a single, space-free `X-Fs-Node-Token: <token>` header
(`append_headers`'s one reliable shape) — see `authorized()` in
`fs.routes.ts` for the matching server-side change, which also makes
Fastify accept the JSON-shaped body this script sends even though
`mod_curl` can never be told to label it `application/json` (setting
Content-Type has the identical one-option limitation).
--]]

local mode = argv[1]
local tenantId = argv[2]
local mailboxId = argv[3]

local api = freeswitch.API()

-- `curl` (mod_curl's own API command, not a shell-out) — `get`/`post`
-- return the response body on stdout; failure is signaled by mod_curl's own
-- prefixed error text, checked below rather than trusted blindly.
--
-- CONFIRMED LIVE (S2-20, G-41): `mod_curl`'s own `curl` API command is not
-- a curl-CLI lookalike — it takes at most *one* option keyword (`-H`/`-d`
-- style flags do not exist at all; the real syntax is documented under
-- `fs_cli -x curl` with no args), and even chaining two of its own
-- documented options together (`content-type <mime>|append_headers
-- <n:v>`, `append_headers <n:v>|append_headers <n:v>` — both shapes its
-- own usage string shows as valid) does not actually work in this
-- FreeSWITCH build: the literal `|...` text gets appended to the first
-- option's own value instead of starting a second option, confirmed
-- directly with a raw packet capture. A *single* `append_headers`, with a
-- header value containing no space, is the one shape that survives
-- intact — see `authorized()` in `fs.routes.ts` for the matching
-- server-side `X-Fs-Node-Token` header this now sends instead of Basic
-- auth (which always has a space after `Basic`). No Content-Type is set
-- here at all for the same reason — the server-side content-type parser
-- was changed to sniff a JSON-shaped body regardless of the (inevitably
-- wrong) label `mod_curl` sends instead.
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

-- Extracts a top-level JSON string field without a full JSON library
-- (none confirmed available in this image's mod_lua build) — good enough
-- for this script's own thin, known-shape internal responses.
-- CONFIRMED LIVE (S2-20, G-41): the required-quotes version of this
-- pattern (`"([^"]*)"`, no `?`) matches a JSON *string* field
-- (`messageId`/`uploadUrl`, both real strings — why `leaveMessage` never
-- surfaced this) but never a bare JSON *boolean*: `/verify-pin`'s own
-- `{"valid":true}` has no quotes around `true` at all, so `authorized`
-- could never become true regardless of whether the PIN itself was
-- right — every retrieval attempt silently fell through to all 3
-- attempts failing, then the same "wrong PIN" goodbye/hangup a genuinely
-- wrong PIN would produce. `conference.lua`'s own `jsonField` already had
-- the fix (optional quotes, `"?...([^,"}]*)"?"`) from its own earlier PIN
-- debugging this same task did (G-50) — this was simply never
-- back-ported here until a *correct* PIN's own retrieval test caught it.
local function jsonField(json, field)
  if json == nil then return nil end
  local pattern = '"' .. field .. '"%s*:%s*"?([^,"}]*)"?'
  return json:match(pattern)
end

local function leaveMessage()
  local created = httpCall("POST", "/fs/voicemail/" .. tenantId .. "/mailbox/" .. mailboxId .. "/messages", "{}")
  local messageId = jsonField(created, "messageId")
  local fileName = jsonField(created, "fileName")
  if messageId == nil or fileName == nil then
    freeswitch.consoleLog("ERR", "voicemail.lua: could not create a message row, aborting leave-message\n")
    return
  end

  -- `recordings_dir` is the spool the uploader watches (vars.xml); the file
  -- name (`vm-<messageId>.wav`) is voicemail-service's, so the uploader can
  -- tell a message from a call recording and knows which one it is.
  local spoolDir = session:getVariable("recordings_dir") or "/var/spool/cuc/rec"
  local spoolPath = spoolDir .. "/" .. fileName
  session:answer()
  session:execute("playback", "silence_stream://1000")
  session:setVariable("RECORD_APPEND", "false")
  session:recordFile(spoolPath, 180, 500, 3)

  -- No upload, no completion call, no delete: the node uploader owns the
  -- file from here (see the header comment).
  session:hangup()
end

local function retrieveMessages()
  session:answer()

  local attempt = 0
  local authorized = false
  while attempt < 3 and not authorized do
    attempt = attempt + 1
    local pin = session:playAndGetDigits(4, 8, 3, 5000, "#", "silence_stream://1000", "silence_stream://1000", "\\d+")
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
    session:execute("playback", "silence_stream://1000")
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

  session:execute("playback", "silence_stream://1000")
  session:hangup()
end

if mode == "leave" then
  leaveMessage()
elseif mode == "retrieve" then
  retrieveMessages()
elseif mode == nil or mode == "" then
  -- Parity 1a: the call-handling dialplan runs this as a fallback whose
  -- arguments come from a channel variable, which is empty when the cause the
  -- call failed with has no voicemail configured. Nothing to do: just end.
  freeswitch.consoleLog("INFO", "voicemail.lua: no mode given; ending the call\n")
  session:hangup()
else
  freeswitch.consoleLog("ERR", "voicemail.lua: unknown mode '" .. tostring(mode) .. "'\n")
  session:hangup()
end
