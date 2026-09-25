--[[
S5-14 (G-111): agent-scoped recording, started when a queue agent answers.

Runs on the agent's leg as it answers. A queue call carries
`execute_on_answer_cuc_agent=lua agent_recording.lua` and lists it, with the
call's own ids, in `cc_export_vars`; `mod_callcenter` copies those to the leg
it originates to the agent, and FreeSWITCH runs every `execute_on_answer*`
variable when that leg answers (`xml.ts`'s `agentAnswerRecordingActions`).

Why here, and not by watching bridges from call-control over ESL: this runs
on the node that owns the call, at the exact moment the agent answers, with
no event subscription to lose or lag, and it keeps FreeSWITCH talking only to
telephony-config (CLAUDE.md rule 4). The decision is not made here: this asks
telephony-config's `/fs/recording/:tenantId/agent-answer`, which asks
recording-service with the answering agent.

- A caller already being recorded (a queue, DID or tenant rule at setup, or a
  flow's) is left alone: no second recording.
- Otherwise, when the answer is `record`, the agent's leg is recorded into the
  spool under the registered opaque id (`record_session`, stereo). The leg is
  answered, so this cannot pre-answer anything; the recording ends with the
  agent's leg. The node uploader delivers it like any other.
- Anything unexpected is logged and the call goes on unrecorded: the caller is
  already connected to the queue.

Unverified live: `cc_export_vars` carrying these variables, `execute_on_answer`
with a suffix running on an originated agent leg, and `record_session` from
that point. `tests/sip/test/recording_agent.test.ts` is the check.
--]]

local json = dofile("/usr/share/freeswitch/scripts/json.lua")
local api = freeswitch.API()

local function log(level, message)
  freeswitch.consoleLog(level, "agent_recording.lua: " .. message .. "\n")
end

local function clean(value)
  if value == nil then return nil end
  value = tostring(value):gsub("%s+$", "")
  if value == "" or value == "_undef_" or value:match("^%-ERR") then return nil end
  return value
end

local tenantId = clean(session:getVariable("cuc_tenant_id"))
local queueId = clean(session:getVariable("cuc_queue_id"))
local agent = clean(session:getVariable("cc_agent"))
local member = clean(session:getVariable("cuc_queue_member_uuid"))
  or clean(session:getVariable("cc_member_session_uuid"))
local didId = clean(session:getVariable("cuc_did_id"))
local nodeId = clean(session:getVariable("cuc_node_id")) or ""

if tenantId == nil or queueId == nil or agent == nil or member == nil then
  log("WARNING", "not a queue call this script can place; nothing done")
  return
end

if clean(api:executeString("uuid_getvar " .. member .. " cuc_recording_id")) ~= nil then
  log("INFO", "the caller is already being recorded; no agent recording")
  return
end

local query = "queueId=" .. queueId .. "&agent=" .. agent .. "&callUuid=" .. member .. "&nodeId=" .. nodeId
if didId ~= nil then query = query .. "&didId=" .. didId end

local baseUrl = session:getVariable("telephony_config_url") or "http://telephony-config:8080"
local token = session:getVariable("telephony_config_token") or ""
local response = api:executeString(
  "curl " .. baseUrl .. "/fs/recording/" .. tenantId .. "/agent-answer?" .. query ..
  " append_headers X-Fs-Node-Token:" .. token .. " get"
)

local decoded = nil
if response ~= nil and response ~= "" and not response:match("^%-ERR") then
  decoded = json.decode(response)
end
if type(decoded) ~= "table" then
  log("ERR", "no usable answer from telephony-config: " .. tostring(response))
  return
end
if decoded.action ~= "record" or type(decoded.path) ~= "string" then return end

session:setVariable("RECORD_STEREO", "true")
session:execute("record_session", decoded.path)
session:setVariable("cuc_recording_id", tostring(decoded.recordingId))
log("INFO", "recording agent " .. agent .. " as " .. tostring(decoded.recordingId))
