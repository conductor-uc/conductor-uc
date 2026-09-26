--[[
S5-13 (G-111): the in-call recording feature codes.

Armed by telephony-config on a call whose deciding recording rule allows on
demand (`xml.ts`'s `recordingFeatureCodeActions`, or `flow_runner.lua` at a
flow's hand-off), as:

    bind_meta_app 1 <legs> s lua::recording_control.lua record    (*1)
    bind_meta_app 2 <legs> s lua::recording_control.lua pause     (*2)

so pressing `*` then the digit runs this script on the leg that pressed it.

It decides nothing. It reads the call's recording state from the channel
that owns the recording (`cuc_rec_owner`, the A leg, exported to the bridged
leg), asks telephony-config's `/fs/recording/:tenantId/control`, which asks
recording-service (the rules, the recording row, the audit event, all in one
transaction), and only then carries out the answer on the owner with
`uuid_record`:

- `start`: `uuid_record <owner> start <path>`, and `cuc_recording_id` set on
  the owner, so the next `*1` stops it and `*2` pauses it. The file lands in
  the spool under an opaque id like every other recording; the node uploader
  delivers it.
- `stop`: `uuid_record <owner> stop <path>`, and `cuc_recording_id` unset.
- `mask` / `unmask` (pause and resume): the paused stretch is written as
  silence, so the file keeps the call's timeline; recording-service stores
  where the pauses are.
- `none`: nothing was done (not allowed, or recording-service could not be
  asked, so nothing could be audited).

Then it plays the neutral tone telephony-config chose back to whoever pressed:
a short beep when something changed, a low double tone when nothing did.

S5-15: after a pause or a resume it also fires a `CUSTOM cuc::recording` event
(`Recording-Call-UUID` the owner, `Recording-Action` paused or resumed; not `Unique-ID`, which would queue the event to the channel instead of firing it). `uuid_record
mask`/`unmask` raise no event of their own (starting and stopping do:
RECORD_START, RECORD_STOP), and call-control turns this one into
`call.channel.recording_paused`/`_resumed`, so a live view shows the pause
whether it came from the phone or from the console (which fires the same event
over ESL with `sendevent`).

The FreeSWITCH names used here (`bind_meta_app`'s argument order, `uuid_record`
with `start|stop|mask|unmask`, `uuid_getvar`, `uuid_setvar`) are confirmed
present in the 1.10.12 binaries' own usage text. Their behaviour on a live
bridged call (which leg runs the script, the beep during a bridge, masking a
recording started with `execute_on_answer=record_session`) is not yet seen on
a real node: `tests/sip/test/recording_on_demand.test.ts` is the check.
--]]

local json = dofile("/usr/share/freeswitch/scripts/json.lua")

local code = argv[1]
local api = freeswitch.API()

-- Played when this script cannot even ask (no context on the call, or no
-- usable answer). The same low double tone telephony-config sends for a refusal.
local REFUSED_TONE = "tone_stream://%(150,100,400);loops=2"

local function log(level, message)
  freeswitch.consoleLog(level, "recording_control.lua [" .. tostring(code) .. "]: " .. message .. "\n")
end

local function clean(value)
  if value == nil then return nil end
  value = tostring(value):gsub("%s+$", "")
  if value == "" or value == "_undef_" or value:match("^%-ERR") then return nil end
  return value
end

local function ownerVariable(owner, name)
  return clean(api:executeString("uuid_getvar " .. owner .. " " .. name))
end

local function beep(tone)
  if tone == nil or tone == json.null or not session:ready() then return end
  session:execute("playback", tone)
end

if code ~= "record" and code ~= "pause" then
  log("ERR", "unknown feature code")
  return
end

local owner = clean(session:getVariable("cuc_rec_owner")) or session:get_uuid()
local tenantId = ownerVariable(owner, "cuc_tenant_id")
local context = ownerVariable(owner, "cuc_rec_ctx")
local recordingId = ownerVariable(owner, "cuc_recording_id")
local nodeId = clean(session:getVariable("cuc_node_id")) or ""

if tenantId == nil or context == nil then
  log("WARNING", "the call has no recording context; nothing done")
  beep(REFUSED_TONE)
  return
end

-- A JSON object with no spaces in it: `mod_curl`'s `post` takes the rest of
-- its arguments as the body, and every value here is an id, a uuid or a
-- base64url token (G-41, voicemail.lua's own httpCall has the full story).
local body = '{"code":"' .. code .. '","callUuid":"' .. owner .. '","context":"' .. context ..
  '","nodeId":"' .. nodeId .. '"'
if recordingId ~= nil then body = body .. ',"recordingId":"' .. recordingId .. '"' end
body = body .. "}"

local baseUrl = session:getVariable("telephony_config_url") or "http://telephony-config:8080"
local token = session:getVariable("telephony_config_token") or ""
local response = api:executeString(
  "curl " .. baseUrl .. "/fs/recording/" .. tenantId .. "/control append_headers X-Fs-Node-Token:" ..
  token .. " post " .. body
)

local decoded = nil
if response ~= nil and response ~= "" and not response:match("^%-ERR") then
  decoded = json.decode(response)
end
if type(decoded) ~= "table" or type(decoded.action) ~= "string" then
  log("ERR", "no usable answer from telephony-config: " .. tostring(response))
  beep(REFUSED_TONE)
  return
end

if decoded.action == "none" then
  log("INFO", "nothing done: " .. tostring(decoded.reason))
  beep(decoded.tone)
  return
end

local verbs = { start = true, stop = true, mask = true, unmask = true }
if not verbs[decoded.action] or type(decoded.path) ~= "string" then
  log("ERR", "unexpected answer: " .. tostring(response))
  beep(REFUSED_TONE)
  return
end

local result = api:executeString("uuid_record " .. owner .. " " .. decoded.action .. " " .. decoded.path)
if result == nil or not result:match("^%+OK") then
  -- Already recorded and audited upstream; the node could not do it. Logged
  -- for the operator; a started recording that never ran is marked failed
  -- by recording-service's pending sweep.
  log("ERR", "uuid_record " .. decoded.action .. " failed: " .. tostring(result))
  beep(REFUSED_TONE)
  return
end

if decoded.action == "start" then
  api:executeString("uuid_setvar " .. owner .. " cuc_recording_id " .. tostring(decoded.recordingId))
elseif decoded.action == "stop" then
  -- No value unsets it: the next *1 starts a new on-demand recording.
  api:executeString("uuid_setvar " .. owner .. " cuc_recording_id")
else
  -- S5-15: mask and unmask raise no event; say so, for the live views.
  local event = freeswitch.Event("CUSTOM", "cuc::recording")
  event:addHeader("Recording-Call-UUID", owner)
  event:addHeader("Recording-Action", decoded.action == "mask" and "paused" or "resumed")
  event:fire()
end
log("INFO", decoded.action .. " " .. tostring(decoded.recordingId))
beep(decoded.tone)
