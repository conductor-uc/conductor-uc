--[[
S2-10: the call-flow (auto attendant) interpreter.

Invoked from the dialplan (telephony-config's own `xml.ts`'s
`buildFlowDialplanDocument`) as:

    lua flow_runner.lua <tenantId> <flowId> <entryPoint>

with `cuc_tenant_domain` and `cuc_opensips_sip_uri` already set as channel
variables, and the call already answered.

Talks to telephony-config's own `/fs/flow/...` and `/fs/media/...` routes over
mod_curl — never to callflow-service directly (CLAUDE.md rule 4: only
telephony-config talks to FS nodes, and symmetrically, this script only ever
talks to telephony-config). `telephony_config_url`/`telephony_config_token`
are the same FreeSWITCH global variables `xml_curl.conf.xml` already uses for
the directory/dialplan/configuration bindings (`vars.xml`).

It walks the compiled IR from `@cuc/callflow-ir` (S2-09): a map of node id ->
`{ id, type, config, ports }`, where `ports` is already resolved to target
node ids, so execution is a port lookup, never an edge search.

UNVERIFIED LIVE (docs/decisions.md G-43, same discipline as G-19/G-20/G-24/
G-35/G-36/G-41 for prior tasks' own FS-side code): the `mod_curl` call shape,
the `http_cache://` URL form with embedded credentials, `playAndGetDigits`'
exact argument order, and the bridge/`continue_on_fail` interaction below are
this task's own best-effort reasoning against FreeSWITCH's documented
surface, not something confirmed against a real FreeSWITCH 1.10.12 node.
Issue #44 (S2-20, the M2 backend SIP regression suite) is where this gets its
first live proof.

S3-11 (G-101): `tests/sip/test/call_flow.test.ts` now runs a published flow live
— the IR fetch, `menu` (prompt, DTMF, port lookup), `voicemail` and `hangup`.
The other node types above are still unproven.
--]]

-- S2-20 (G-43): loaded from mod_lua's own compiled-in default script
-- directory (G-50's own confirmed fix) — `/etc/freeswitch/scripts/` was a
-- stale path from before that fix, silently never hit because `mod_lua`'s
-- own `script-directory` misconfiguration (also G-50) meant this whole
-- script never actually ran until that pass.
local json = dofile("/usr/share/freeswitch/scripts/json.lua")

local tenantId = argv[1]
local flowId = argv[2]
local entryPoint = argv[3]

local api = freeswitch.API()

--[[
The loop guard. A published flow is validated for *structural* reachability
(S2-09's `validateGraph`), but nothing stops a legitimately valid graph from
cycling at runtime — `menu` -> `play` -> `goto_flow` -> back to the same menu
is a perfectly well-formed graph and an infinite call.

Counting node *visits* rather than detecting a repeated node id is
deliberate: revisiting a node is normal and wanted (a menu replaying its
prompt after an invalid digit is the obvious case), so a "have I been here
before" check would break ordinary flows. A visit budget bounds the call
without forbidding legitimate repetition.
--]]
local MAX_NODE_VISITS = 100

--[[
Where a fetched IR is cached, keyed by flow *and version* — see `fetchIr`
below for why the version is in the filename rather than the IR simply being
overwritten in place.
--]]
local CACHE_DIR = "/var/cache/cuc/flow"

local function log(level, message)
  freeswitch.consoleLog(level, "flow_runner.lua [" .. tostring(flowId) .. "]: " .. message .. "\n")
end

-- ---------------------------------------------------------------------------
-- HTTP
-- ---------------------------------------------------------------------------

local function configUrl()
  return session:getVariable("telephony_config_url") or "http://telephony-config:8080"
end

local function configToken()
  return session:getVariable("telephony_config_token") or ""
end

--[[
`curl` here is mod_curl's own API command, not a shell-out — and not a
curl-CLI lookalike either: `-H`/`-d` flags do not exist. CONFIRMED LIVE
(S2-20, G-43): this script's own original `-H "Authorization: Basic
<base64>"` never worked, for two compounding reasons — `-H` is not a real
`mod_curl` option at all (its actual syntax is `append_headers
<name:value>`, found only while debugging `conference.lua`/
`voicemail.lua`'s identical bug), and even with the right option name, a
value containing a space (which `Basic <token>` always has) gets silently
truncated at the space by `mod_curl`'s own non-shell-like argument parser.
A single `append_headers X-Fs-Node-Token:<token>` — no scheme, no
encoding, no embedded space — is the one shape that survives it intact;
see `authorized()` in `fs.routes.ts` for the matching server-side header.
It writes the response body to stdout, signalling failure with its own
prefixed error text rather than a status code, so the caller checks the
body rather than trusting it blindly.
--]]
local function httpGet(path)
  local response = api:executeString(
    "curl " .. configUrl() .. path .. " append_headers X-Fs-Node-Token:" .. configToken() .. " get"
  )
  if response == nil or response == "" then return nil, "empty response" end
  if response:match("^%-ERR") then return nil, response end
  return response
end

--[[
The `http_cache://` URL `playback` streams a media asset from.

Credentials go inline in the URL because `/fs/media/...` is token-gated like
every other `/fs/...` route, and `mod_http_cache` issues a plain GET with no
way to attach a header from the dialplan. `http://user:pass@host/path` is the
standard way to carry Basic auth in a URL, and mod_http_cache's underlying
libcurl honours it — but this exact combination is part of what G-43 flags as
unverified until issue #44 runs it live.

8 kHz is the variant requested: these are narrowband SIP calls, and asking
for the 16 kHz variant would only make FreeSWITCH resample it back down.
--]]
local function mediaUrl(assetId)
  local base = configUrl():gsub("^(https?://)", "%1fs-node:" .. configToken() .. "@")
  return "http_cache://" .. base .. "/fs/media/" .. tenantId .. "/" .. assetId .. "/8k.wav"
end

-- ---------------------------------------------------------------------------
-- IR fetch + on-disk cache
-- ---------------------------------------------------------------------------

local function cachePath(targetFlowId, versionNumber)
  return CACHE_DIR .. "/" .. tenantId .. "-" .. targetFlowId .. "-v" .. tostring(versionNumber) .. ".json"
end

local function readFile(path)
  local handle = io.open(path, "r")
  if handle == nil then return nil end
  local contents = handle:read("*a")
  handle:close()
  return contents
end

local function writeFile(path, contents)
  os.execute("mkdir -p " .. CACHE_DIR)
  local handle = io.open(path, "w")
  if handle == nil then
    log("WARNING", "could not write the IR cache at " .. path)
    return
  end
  handle:write(contents)
  handle:close()
end

--[[
Fetches a flow's published IR, caching it on disk by version.

The service call happens on every call rather than only on a cache miss, and
that is the point: the IR endpoint returns the version *with* the IR, so the
only way to notice a `:publish` is to ask. "A published new version takes
effect on the next call" (this task's own "Done when") is exactly that
property, and a cache consulted first would break it.

So what the on-disk cache buys is availability, not latency: when
callflow-service or telephony-config cannot be reached, a node that has run
this flow before still runs it, from the newest version it has on disk,
instead of dropping the call. Keying the file on the version number — which
`flow_versions` guarantees is monotonic and never reused, even across a
rollback — is what makes a stale cache entry impossible to mistake for a
current one.
--]]
local function fetchIr(targetFlowId)
  local body, err = httpGet("/fs/flow/" .. tenantId .. "/" .. targetFlowId .. "/ir")

  if body ~= nil then
    local decoded, decodeErr = json.decode(body)
    if decoded ~= nil and decoded.ir ~= nil then
      writeFile(cachePath(targetFlowId, decoded.versionNumber), body)
      return decoded.ir
    end
    log("ERR", "the IR response did not parse: " .. tostring(decodeErr))
  else
    log("ERR", "could not fetch the IR: " .. tostring(err))
  end

  -- Fall back to the newest cached version for this flow.
  local newest, newestVersion = nil, -1
  local listing = io.popen('ls -1 "' .. CACHE_DIR .. '" 2>/dev/null')
  if listing ~= nil then
    local prefix = tenantId .. "-" .. targetFlowId .. "-v"
    for name in listing:lines() do
      local version = tonumber(name:match("^" .. prefix:gsub("%p", "%%%0") .. "(%d+)%.json$"))
      if version ~= nil and version > newestVersion then
        newest, newestVersion = name, version
      end
    end
    listing:close()
  end

  if newest == nil then return nil end
  log("WARNING", "serving flow version " .. tostring(newestVersion) .. " from the on-disk cache")
  local cached = readFile(CACHE_DIR .. "/" .. newest)
  if cached == nil then return nil end
  local decoded = json.decode(cached)
  return decoded ~= nil and decoded.ir or nil
end

-- ---------------------------------------------------------------------------
-- Node handlers
--
-- Each returns the id of the next node to execute, or nil to end the call.
-- ---------------------------------------------------------------------------

local handlers = {}

function handlers.play(node)
  session:execute("playback", mediaUrl(node.config.mediaAssetId))
  return node.ports.next
end

--[[
`menu` is the one node that reads DTMF. `playAndGetDigits` plays the prompt
and collects a single digit, replaying on an invalid entry, which is exactly
the IVR semantics wanted — but its "invalid" handling only covers input that
fails the regex, not a digit with no wired edge, so the two are handled
separately here.

An unwired digit counts as invalid rather than as a timeout: the caller did
press something, and telling them "that isn't an option" is the honest
response. Exceeding `maxInvalidAttempts` takes the `invalid` port.
--]]
function handlers.menu(node)
  local config = node.config
  local attempts = 0

  while attempts < config.maxInvalidAttempts do
    if not session:ready() then return nil end

    -- One digit, no terminator, prompt played once per attempt; the empty
    -- invalid-file argument keeps the retry prompt the same as the first.
    local digit = session:playAndGetDigits(
      1, 1, 1,
      config.timeoutSeconds * 1000,
      "",
      mediaUrl(config.promptMediaAssetId),
      "",
      "[0-9*#]"
    )

    if digit == nil or digit == "" then
      log("INFO", "menu '" .. node.id .. "' timed out")
      return node.ports.timeout
    end

    local target = node.ports[digit]
    if target ~= nil then return target end

    attempts = attempts + 1
    log("INFO", "menu '" .. node.id .. "' got unmapped digit '" .. digit .. "'")
  end

  return node.ports.invalid
end

--[[
`time_condition` asks whether the tenant's schedule is open *now* (S3-10,
G-59), taking `match` when it is and `noMatch` when it is not.

The question goes to telephony-config on every call, which asks
pbx-config-service, which evaluates the schedule in its own time zone against
its holidays. Nothing is cached here or baked into the published IR: editing a
schedule's hours or a holiday takes effect on the next call without
republishing any flow, the node holds no state (CLAUDE.md rule 5), and this
script never has to do time zone arithmetic, which Lua cannot do without a
tz database.

When the answer cannot be had (the schedule was deleted, or a service is
unreachable) the caller is treated as outside hours and takes `noMatch`:
after-hours handling (voicemail, a recorded message) is the safe place to
send a call nobody can vouch is inside hours, and the failure is logged.

A flow published before schedules existed carries a time zone and no
schedule id (its IR is immutable, so it stays that way). It keeps the
behavior it always had, taking `match`, and says so in the log; the owner is
told to choose a schedule the next time the flow is validated or published.
--]]
function handlers.time_condition(node)
  local scheduleId = node.config.scheduleId
  if scheduleId == nil then
    log("WARNING", "time_condition '" .. node.id .. "' was published without a schedule; taking 'match'")
    return node.ports.match
  end

  local body, err = httpGet("/fs/flow/" .. tenantId .. "/schedule/" .. scheduleId .. "/open")
  if body == nil then
    log("WARNING", "time_condition '" .. node.id .. "' could not read schedule '" .. scheduleId .. "' (" .. tostring(err) .. "); treating it as closed")
    return node.ports.noMatch
  end

  local decoded = json.decode(body)
  if type(decoded) ~= "table" or type(decoded.open) ~= "boolean" then
    log("WARNING", "time_condition '" .. node.id .. "' got an unreadable answer for schedule '" .. scheduleId .. "'; treating it as closed")
    return node.ports.noMatch
  end

  if decoded.open then return node.ports.match end
  return node.ports.noMatch
end

--[[
Bridges to a single extension, then continues on the `noAnswer` port if the
leg did not connect.

`continue_on_fail` is what makes FreeSWITCH proceed to the next action rather
than ending the call when `bridge` fails — the same mechanism, and the same
cause list, `buildDialplanDocument` already uses for its voicemail fallback
(S2-16). The bridge target routes back out through OpenSIPs
(`sip_route_uri`), exactly as every other bridge this platform builds does,
so the edge stays the only thing that decides where a registered AOR lives.
--]]
local function bridgeNumbers(numbers, timeoutSeconds, separator, legVars)
  local domain = session:getVariable("cuc_tenant_domain")
  local routeUri = session:getVariable("cuc_opensips_sip_uri")
  local extra = ""
  if legVars ~= nil and legVars ~= "" then extra = "," .. legVars end
  local legs = {}
  for i, number in ipairs(numbers) do
    legs[i] = "{sip_route_uri=sip:" .. routeUri .. extra .. "}sofia/internal/" .. number .. "@" .. domain
  end

  session:setVariable("continue_on_fail", "NORMAL_CLEARING,USER_BUSY,NO_ANSWER,ORIGINATOR_CANCEL,UNALLOCATED_NUMBER")
  session:setVariable("call_timeout", tostring(timeoutSeconds))
  session:execute("bridge", table.concat(legs, separator))
end

--[[
S2-12 (04 §3.3): this node's own affinity identity — `vars.xml`'s
`cuc_node_id` (`env-set FS_NODE_ID`), read the same way `telephony_config_url`/
`telephony_config_token` already are (a global var, not a per-call channel
`set`, since it is the node's own identity, not anything about this call).
--]]
local function ownNodeId()
  return session:getVariable("cuc_node_id") or ""
end

--[[
Resolves whether a pinned resource (`kind` one of `queue`/`park`/`conf`,
04 §3.3) is this node's to run locally, or leased to another node.

Returns `true` when it's local — either already leased to this node, or not
leased to anyone yet (04 §3.3: "Otherwise the runner acquires the lease
locally" — *acquiring* it is each resource kind's own concern, S2-13/14/15,
not this helper's: it only answers the question). Returns `false` plus the
actual holder's node id when leased elsewhere, for `hairpinTransfer` below.

A failed or unparseable affinity check degrades to "local" rather than
hairpinning on a guess — "an honest local attempt beats a blind transfer".

Not currently called by any handler: `handlers.queue` below uses its own
dedicated `/fs/flow/.../queue/:queueId` endpoint instead, which resolves
*and* acquires in one round trip rather than the read-only check this
function does — but a future resource kind whose own resolution doesn't
need to acquire anything (or that wants the acquire/check split into two
steps) can use this directly.
--]]
local function resolveAffinity(kind, resourceId)
  local body, err = httpGet("/fs/affinity/" .. tenantId .. "/" .. kind .. "/" .. resourceId)
  if body == nil then
    log("WARNING", "affinity check for " .. kind .. " '" .. resourceId .. "' failed (" .. tostring(err) .. "); assuming local")
    return true
  end

  local decoded = json.decode(body)
  local ownerNodeId = decoded ~= nil and decoded.nodeId or nil
  if ownerNodeId == nil or ownerNodeId == json.null or ownerNodeId == ownNodeId() then
    return true
  end
  return false, ownerNodeId
end

--[[
The "hairpin" (04 §3.3): sends the call back out through OpenSIPs carrying
an `X-Affinity-Node` hint naming the node that actually holds the lease.

UNVERIFIED LIVE and, despite having a real caller as of S2-13 (`handlers.
queue` below), still practically unreachable (docs/decisions.md G-46, same
discipline as G-43/G-45/G-47 above): `opensips.cfg.template`'s own `route{}`
does not yet read this header at all (its own comment on the `cachedb_redis`
load: "read by call-control (S2+), not by anything in this script") —
teaching OpenSIPs to dispatch on it is S4-05's job ("Affinity routing at
OpenSIPs + multi-node lease tests"), not this one's. With exactly one FS
node in the dev stack (S2-19 adds the second), a queue's lease can only
ever resolve to that same node, so `handlers.queue`'s hairpin branch can
never actually run yet — reachable in code, not in practice.
--]]
local function hairpinTransfer(targetNodeId)
  local domain = session:getVariable("cuc_tenant_domain")
  local routeUri = session:getVariable("cuc_opensips_sip_uri")
  log("INFO", "hairpinning to node '" .. targetNodeId .. "' via " .. tostring(routeUri))
  session:setVariable("sip_h_X-Affinity-Node", targetNodeId)
  session:execute("bridge", "{sip_route_uri=sip:" .. tostring(routeUri) .. "}sofia/internal/" .. tenantId .. "@" .. tostring(domain))
end

-- ---------------------------------------------------------------------------
-- Recording at the hand-off (S5-11 (b), G-111)
--
-- When the flow hands the call to an extension, ring group or queue, the
-- lookup for that target also carries the recording decision for it:
-- telephony-config asks recording-service (the same precedence rules as a
-- call that reaches the target directly) and answers with an instruction.
-- No policy logic lives here; this script only carries the instruction out.
--
-- A call already being recorded (tenant or DID rules at flow entry, or an
-- earlier hand-off) says so (`recording=1`), and gets no second recording.
-- ---------------------------------------------------------------------------

local function isSet(value)
  return value ~= nil and value ~= "" and value ~= "_undef_"
end

-- The query string that asks for a recording decision with a lookup.
local function recordingQuery()
  local query = "callUuid=" .. session:get_uuid() .. "&nodeId=" .. ownNodeId()
  local didId = session:getVariable("cuc_did_id")
  if isSet(didId) then query = query .. "&didId=" .. didId end
  if isSet(session:getVariable("cuc_recording_id")) then
    query = query .. "&recording=1"
  else
    query = query .. "&recording=0"
  end
  return query
end

--[[
Carries out a hand-off's recording instruction. The call is already answered
(the flow answered it), so running `record_session` directly is safe here: the
S5-02 lesson (a direct `record_session` pre-answers an unanswered call and
kills ringback) does not apply to an answered channel.

`startsOnAnswer` (extension and ring-group targets) arms the recording on
this channel to start only when a called phone answers, through the B leg's
own `api_on_answer`, so ringing, and a caller who gives up and falls through
to voicemail, are not recorded under the extension's rule. Queues record from
the hand-off, like a DID straight to a queue does (the caller is answered and
waiting). Returns the leg variables to add to the bridge, or "".

UNVERIFIED LIVE: `api_on_answer` on a bridged leg running `uuid_record` for
this (the A) channel is FreeSWITCH's documented variable and API, not yet
seen on a real node (tests/sip/test/recording_flow.test.ts is the check).
--]]
local pendingRecording = nil

--[[
S5-13: arms the recording feature codes (`*1` on demand, `*2` pause) when the
target's rule allows them, the same actions `/fs/dialplan` adds for a call
that reaches the target directly (`xml.ts`'s `recordingFeatureCodeActions`).
Binding a key again replaces the earlier binding, so a hand-off whose rule
differs from the flow entry's takes over with its own call context.
--]]
local function armFeatureCodes(codes)
  if type(codes) ~= "table" or type(codes.listen) ~= "string" or type(codes.context) ~= "string" then
    return
  end
  session:setVariable("cuc_rec_ctx", codes.context)
  session:execute("export", "cuc_rec_owner=" .. session:get_uuid())
  -- S5-15: what the console's buttons may do on this call (`on_demand` or
  -- `pause`), read by call-control from the channel's events.
  if codes.controls == "on_demand" or codes.controls == "pause" then
    session:execute("export", "cuc_rec_controls=" .. codes.controls)
  end
  session:setVariable("RECORD_STEREO", "true")
  session:execute("bind_meta_app", "1 " .. codes.listen .. " s lua::recording_control.lua record")
  session:execute("bind_meta_app", "2 " .. codes.listen .. " s lua::recording_control.lua pause")
end

local function applyRecording(instruction, startsOnAnswer)
  if type(instruction) ~= "table" then return "" end
  armFeatureCodes(instruction.featureCodes)
  -- S5-12: the tenant requires recording and it cannot be set up. The tone
  -- and the cause come from telephony-config; the caller hears the neutral
  -- tone and the call ends. Callers check `session:ready()` after this.
  if instruction.action == "refuse" then
    log("WARNING", "recording is required and cannot be set up; refusing the call")
    session:setVariable("cuc_recording_status", "refused")
    if instruction.tone ~= nil and instruction.tone ~= json.null then
      session:execute("playback", instruction.tone)
    end
    session:hangup(instruction.cause or "NORMAL_TEMPORARY_FAILURE")
    return ""
  end
  if instruction.action == "unavailable" then
    session:setVariable("cuc_recording_status", "unavailable")
    return ""
  end
  if instruction.action ~= "record" or instruction.path == nil then return "" end

  if instruction.announcement ~= nil and instruction.announcement ~= json.null then
    session:execute("playback", instruction.announcement)
  end
  session:setVariable("RECORD_STEREO", "true")
  session:setVariable("recording_follow_transfer", "true")

  if startsOnAnswer then
    pendingRecording = instruction
    -- Set now, so a feature code pressed during the bridged call (S5-13)
    -- finds the recording; `settleRecording` unsets it if no phone answered.
    session:setVariable("cuc_recording_id", instruction.recordingId)
    return "api_on_answer='uuid_record " .. session:get_uuid() .. " start " .. instruction.path .. "'"
  end
  session:execute("record_session", instruction.path)
  session:setVariable("cuc_recording_id", instruction.recordingId)
  return ""
end

-- After a bridge: if the armed recording started (its file exists), the call
-- is recorded, and a later hand-off must not start a second one. If no phone
-- answered, it never started, so the call is not marked as recorded.
local function settleRecording()
  if pendingRecording == nil then return end
  local handle = io.open(pendingRecording.path, "r")
  if handle ~= nil then
    handle:close()
  elseif session:ready() then
    session:execute("unset", "cuc_recording_id")
  end
  pendingRecording = nil
end

function handlers.extension(node)
  local resolved = httpGet(
    "/fs/flow/" .. tenantId .. "/extension/" .. node.config.extensionId .. "?" .. recordingQuery()
  )
  local decoded = resolved ~= nil and json.decode(resolved) or nil
  if decoded == nil or decoded.number == nil then
    log("ERR", "extension node '" .. node.id .. "' could not resolve its extension")
    return node.ports.noAnswer
  end

  local legVars = applyRecording(decoded.recording, true)
  if not session:ready() then return nil end
  bridgeNumbers({ decoded.number }, node.config.ringSeconds, ",", legVars)
  settleRecording()
  if session:getVariable("bridge_hangup_cause") == nil and not session:ready() then return nil end
  return node.ports.noAnswer
end

--[[
Ring groups: telephony-config resolves the group to an *ordered* list of
member numbers, because ordering is where the strategy lives — `round_robin`'s
rotation counter is in Redis, not on this node (S2-08), and `random`'s shuffle
belongs with it so every node in a cluster agrees on the policy.

The separator is what turns that list into a strategy for FreeSWITCH: `,`
rings every leg at once (simultaneous), `|` rings them in order (sequential,
and what `round_robin`/`random` become once the ordering has been applied).
--]]
function handlers.ring_group(node)
  local resolved = httpGet(
    "/fs/flow/" .. tenantId .. "/ring-group/" .. node.config.ringGroupId .. "?" .. recordingQuery()
  )
  local decoded = resolved ~= nil and json.decode(resolved) or nil
  if decoded == nil or decoded.numbers == nil or #decoded.numbers == 0 then
    log("ERR", "ring_group node '" .. node.id .. "' could not resolve its members")
    return node.ports.noAnswer
  end

  local separator = decoded.strategy == "simultaneous" and "," or "|"
  local legVars = applyRecording(decoded.recording, true)
  if not session:ready() then return nil end
  bridgeNumbers(decoded.numbers, decoded.ringTimeoutSeconds, separator, legVars)
  settleRecording()
  if not session:ready() then return nil end
  return node.ports.noAnswer
end

--[[
Queues (S2-13; `mod_callcenter`). Resolves the queue through telephony-
config's own `/fs/flow/.../queue/:queueId?nodeId=...` — unlike `resolveAffinity`
above (a plain read), this endpoint also *acquires* the lease, preferring
this node when the queue is not yet leased to anyone (04 §3.3: "otherwise
the runner acquires the lease locally" — a call already running here is the
natural owner of an unleased queue, not a candidate for load-balancing
elsewhere). If it comes back leased to a different node, this hairpins
there instead of handing the call to a `callcenter` config this node has
never loaded.

The node takes its `next` port rather than hanging up on a resolve failure:
a flow that routes to a queue almost always has something after it
(voicemail, an overflow menu), so falling through keeps the caller moving
instead of dropping them — the same reasoning this handler's own previous
G-43 stub already established.

UNVERIFIED LIVE — G-47 (docs/decisions.md), same discipline as this file's
own G-43: the `callcenter` application's argument shape (a bare queue name)
is `mod_callcenter`'s documented dialplan API, not invented, but not run
against a real FreeSWITCH process.
--]]
function handlers.queue(node)
  local resolved = httpGet(
    "/fs/flow/" .. tenantId .. "/queue/" .. node.config.queueId .. "?" .. recordingQuery()
  )
  local decoded = resolved ~= nil and json.decode(resolved) or nil
  if decoded == nil or decoded.queueName == nil then
    log("ERR", "queue node '" .. node.id .. "' could not resolve its queue")
    return node.ports.next
  end

  if decoded.isLocal == false then
    hairpinTransfer(decoded.nodeId)
    return nil
  end

  applyRecording(decoded.recording, false)
  if not session:ready() then return nil end

  -- S5-14: arms agent-scoped recording for when an agent answers, the same
  -- variables `/fs/dialplan` sets for a DID straight to a queue (`xml.ts`'s
  -- `agentAnswerRecordingActions`; keep the two in step). The call is
  -- already answered, so `execute_on_answer_cuc_agent` never runs here; the
  -- agent leg gets it through `cc_export_vars`.
  session:setVariable("cuc_queue_id", node.config.queueId)
  session:setVariable("cuc_queue_member_uuid", session:get_uuid())
  session:setVariable("execute_on_answer_cuc_agent", "lua agent_recording.lua")
  session:setVariable(
    "cc_export_vars",
    "cuc_tenant_id,cuc_queue_id,cuc_did_id,cuc_queue_member_uuid,execute_on_answer_cuc_agent,cuc_rec_owner"
  )

  session:execute("callcenter", decoded.queueName)
  if not session:ready() then return nil end
  return node.ports.next
end

--[[
Hands off to the S2-16 voicemail app rather than reimplementing recording
here — it already owns creating the message, recording it to the spool (the
node uploader delivers it, S5-16) and the greeting handling.
--]]
function handlers.voicemail(node)
  session:execute("lua", "voicemail.lua leave " .. tenantId .. " " .. node.config.mailboxId)
  return node.ports.next
end

function handlers.hangup()
  return nil
end

-- `goto_flow` is handled in the main loop, which owns the IR being walked.
function handlers.goto_flow()
  return nil
end

-- ---------------------------------------------------------------------------
-- Main loop
-- ---------------------------------------------------------------------------

local ir = fetchIr(flowId)
if ir == nil then
  log("ERR", "no IR available for this flow; hanging up")
  session:hangup()
  return
end

local currentNodeId = ir.entryPoints[entryPoint]
if currentNodeId == nil then
  log("ERR", "flow has no entry point named '" .. tostring(entryPoint) .. "'; hanging up")
  session:hangup()
  return
end

local visits = 0
while currentNodeId ~= nil do
  if not session:ready() then
    log("INFO", "caller hung up")
    break
  end

  visits = visits + 1
  if visits > MAX_NODE_VISITS then
    log("ERR", "loop guard tripped after " .. tostring(MAX_NODE_VISITS) .. " node visits; hanging up")
    break
  end

  local node = ir.nodes[currentNodeId]
  if node == nil then
    log("ERR", "flow references a node id that is not in the IR: '" .. tostring(currentNodeId) .. "'")
    break
  end

  -- `goto_flow` swaps the IR being walked, so it lives here rather than in a
  -- handler: it is the one node that changes the interpreter's own state.
  -- The visit budget deliberately carries across the jump, so a cycle of
  -- flows calling each other is bounded exactly like a cycle inside one.
  if node.type == "goto_flow" then
    local nextIr = fetchIr(node.config.flowId)
    if nextIr == nil then
      log("ERR", "goto_flow '" .. node.id .. "' could not load flow '" .. tostring(node.config.flowId) .. "'")
      break
    end
    local target = nextIr.entryPoints[node.config.entryPoint]
    if target == nil then
      log("ERR", "goto_flow '" .. node.id .. "' target flow has no entry point '" .. tostring(node.config.entryPoint) .. "'")
      break
    end
    ir = nextIr
    currentNodeId = target
  else
    local handler = handlers[node.type]
    if handler == nil then
      log("ERR", "no handler for node type '" .. tostring(node.type) .. "'")
      break
    end
    currentNodeId = handler(node)
  end
end

if session:ready() then session:hangup() end
