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
--]]

local json = dofile("/etc/freeswitch/scripts/json.lua")

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

local B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

--[[
Base64, in pure Lua.

`voicemail.lua` (S2-16) builds the same Basic-auth header by shelling out to
`base64` through `shell_exec`. That works only where `mod_dptools`' shell
access is available and unrestricted, which is a deployment property this
script should not depend on for something as small as encoding 40 bytes.
--]]
local function base64(input)
  local out = {}
  for chunk in input:gmatch("..?.?") do
    local a, b, c = chunk:byte(1, 3)
    local n = a * 0x10000 + (b or 0) * 0x100 + (c or 0)
    local indices = {
      math.floor(n / 0x40000) % 0x40,
      math.floor(n / 0x1000) % 0x40,
      math.floor(n / 0x40) % 0x40,
      n % 0x40,
    }
    local encoded = {}
    for i = 1, 4 do
      encoded[i] = B64_ALPHABET:sub(indices[i] + 1, indices[i] + 1)
    end
    -- Pad according to how many source bytes this chunk actually had.
    if c == nil then encoded[4] = "=" end
    if b == nil then encoded[3] = "=" end
    out[#out + 1] = table.concat(encoded)
  end
  return table.concat(out)
end

local function configUrl()
  return session:getVariable("telephony_config_url") or "http://telephony-config:8080"
end

local function configToken()
  return session:getVariable("telephony_config_token") or ""
end

--[[
`curl` here is mod_curl's own API command, not a shell-out. It writes the
response body to stdout, signalling failure with its own prefixed error text
rather than a status code, so the caller checks the body rather than trusting
it blindly.
--]]
local function httpGet(path)
  local header = "Authorization: Basic " .. base64("fs-node:" .. configToken())
  local response = api:executeString("curl " .. configUrl() .. path .. " get -H \"" .. header .. "\"")
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
  return "http_cache://" .. base .. "/fs/media/" .. tenantId .. "/" .. assetId .. "/8k"
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
`time_condition` is, today, a pass-through that takes `match`.

S2-09's IR gives this node a `timezone` and nothing else, while 03 §2.3
describes it as keyed on a `scheduleId` — and schedules do not exist as a
subsystem until S3-08. With no hours to compare the current time against,
every honest evaluation is "no schedule says we are closed".

Inventing a default business-hours window here (the obvious temptation:
Mon-Fri 09:00-17:00) would silently send after-hours callers down the
`noMatch` branch on a rule nobody configured, which is worse than not
branching at all. So this takes `match`, logs that it did, and S3-08 is what
makes the node real. Flagged as G-43 in docs/decisions.md.

The optional `businessHours` config below is read if a caller *does* supply
it, so a future schema addition works without changing this script.
--]]
function handlers.time_condition(node)
  local hours = node.config.businessHours
  if hours == nil then
    log("INFO", "time_condition '" .. node.id .. "' has no schedule; taking 'match' (G-43)")
    return node.ports.match
  end

  -- `os.date` works in the container's own local time. A flow whose timezone
  -- differs from the node's would evaluate against the wrong clock, which is
  -- the other half of why this waits for real schedule support.
  local now = os.date("*t")
  local minutes = now.hour * 60 + now.min
  local openAt = (hours.startHour or 0) * 60
  local closeAt = (hours.endHour or 24) * 60
  local dayAllowed = hours.days == nil or hours.days[tostring(now.wday)] == true
  local isOpen = dayAllowed and minutes >= openAt and minutes < closeAt

  return isOpen and node.ports.match or node.ports.noMatch
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
local function bridgeNumbers(numbers, timeoutSeconds, separator)
  local domain = session:getVariable("cuc_tenant_domain")
  local routeUri = session:getVariable("cuc_opensips_sip_uri")
  local legs = {}
  for i, number in ipairs(numbers) do
    legs[i] = "{sip_route_uri=sip:" .. routeUri .. "}sofia/internal/" .. number .. "@" .. domain
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
hairpinning on a guess — the same "an honest local attempt beats a blind
transfer" bias `handlers.queue`'s own G-43 stub already takes for a missing
subsystem, applied here to a missing *answer*.
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

UNVERIFIED LIVE and presently inert (docs/decisions.md G-46, same discipline
as G-43/G-45 above): `opensips.cfg.template`'s own `route{}` does not yet
read this header at all (its own comment on the `cachedb_redis` load: "read
by call-control (S2+), not by anything in this script") — teaching OpenSIPs
to dispatch on it is S4-05's job ("Affinity routing at OpenSIPs + multi-node
lease tests"), not this one's. This function exists so S2-13/14/15 have a
single, correct place to call once they have a real pinned resource to
hairpin *to* — today, with exactly one FS node in the dev stack (S2-19 adds
the second), there is nowhere for a hairpin to actually go, so nothing in
this file calls it yet.
--]]
local function hairpinTransfer(targetNodeId)
  local domain = session:getVariable("cuc_tenant_domain")
  local routeUri = session:getVariable("cuc_opensips_sip_uri")
  log("INFO", "hairpinning to node '" .. targetNodeId .. "' via " .. tostring(routeUri))
  session:setVariable("sip_h_X-Affinity-Node", targetNodeId)
  session:execute("bridge", "{sip_route_uri=sip:" .. tostring(routeUri) .. "}sofia/internal/" .. tenantId .. "@" .. tostring(domain))
end

function handlers.extension(node)
  local resolved = httpGet("/fs/flow/" .. tenantId .. "/extension/" .. node.config.extensionId)
  local decoded = resolved ~= nil and json.decode(resolved) or nil
  if decoded == nil or decoded.number == nil then
    log("ERR", "extension node '" .. node.id .. "' could not resolve its extension")
    return node.ports.noAnswer
  end

  bridgeNumbers({ decoded.number }, node.config.ringSeconds, ",")
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
  local resolved = httpGet("/fs/flow/" .. tenantId .. "/ring-group/" .. node.config.ringGroupId)
  local decoded = resolved ~= nil and json.decode(resolved) or nil
  if decoded == nil or decoded.numbers == nil or #decoded.numbers == 0 then
    log("ERR", "ring_group node '" .. node.id .. "' could not resolve its members")
    return node.ports.noAnswer
  end

  local separator = decoded.strategy == "simultaneous" and "," or "|"
  bridgeNumbers(decoded.numbers, decoded.ringTimeoutSeconds, separator)
  if not session:ready() then return nil end
  return node.ports.noAnswer
end

--[[
Queues are S2-13's subsystem and do not exist yet — `resolveAffinity`/
`hairpinTransfer` above are ready for S2-13 to call once `node.config.queueId`
names a real, leaseable queue, but there is nothing real to check affinity
against today, so this stays the same G-43 stub.

The node takes its `next` port rather than hanging up: a flow that routes to
a queue almost always has something after it (voicemail, an overflow menu),
so falling through keeps the caller moving instead of dropping them. Logged
at ERR because a silently skipped queue is a real routing surprise, not a
benign no-op. Flagged as G-43.
--]]
function handlers.queue(node)
  log("ERR", "queue node '" .. node.id .. "' skipped: queues arrive in S2-13 (G-43)")
  return node.ports.next
end

--[[
Hands off to the S2-16 voicemail app rather than reimplementing recording
here — it already owns the spool-then-upload-then-complete sequence and the
greeting handling.
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
