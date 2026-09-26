--[[
S2-20 (G-47, docs/decisions.md): runs `callcenter_config agent set status`
via FS's own API layer. Invoked from the dialplan
(`buildAgentStatusDialplanDocument`, `services/telephony-config/src/xml.ts`)
as:

    lua agent_status.lua <agentName> <available:0|1> [<opensips sip uri>]

There is no dialplan application in this image's module set that runs an
arbitrary FS API command directly — confirmed live: the original dialplan
action here was `<action application="api" data="callcenter_config ..."/>`,
and FreeSWITCH rejected it outright (`switch_core_session.c:2766 Invalid
Application api`, then hung up the channel with
`DESTINATION_OUT_OF_ORDER`). `mod_dptools`'s own application list has no
"api" entry at all — that assumption was simply wrong, not merely
unverified. A scripting-language binding calling `api:executeString` is
the standard FreeSWITCH idiom for this, the same one `conference.lua`/
`voicemail.lua` already use for their own API calls.

`available` travels as `0`/`1` rather than the literal status string:
`mod_callcenter`'s own "Logged Out" status contains a space, which would
silently corrupt this argv's own space-delimited parsing — the same class
of pitfall `conference.lua`'s own `pinRequired:0|1` argv already
sidesteps.

CONFIRMED LIVE (S2-20, another real bug, not just unverified): `set
status` alone is only a no-op success against an agent `mod_callcenter`
already has loaded in memory — and `mod_callcenter`'s own lazy, per-call
reload path (triggered by `callcenter()` touching a queue it hasn't seen
yet) genuinely only loads the *queue*, never its agents or tiers (checked
directly: `callcenter_config agent list` stays empty no matter how many
queues get loaded this way; only `mod_callcenter`'s own one-time,
module-load-time config parse ever populates agents/tiers). Any agent
created after the node has already booted — i.e. ordinarily, always, in a
real deployment — could never actually log in before this fix, silently:
`set status` against a nonexistent agent is a silent no-op, not an error.
Fixed by ensuring the agent exists first: `agent add` (idempotent —
confirmed live, re-adding an already-loaded agent returns `-ERR Agent
already exist!` and leaves its existing state untouched, which
`api:executeString` never inspects anyway) and `agent set contact`, both
before `set status`. This does not fix the *tier* side of the same gap
(a queue's own tier assignments have the identical lazy-load hole,
confirmed the same way) — see `docs/decisions.md` G-47 for why that one
is left as a documented gap rather than fixed here: it is the queue's own
provisioning concern, not this feature code's.
--]]

local agentName = argv[1]
local available = argv[2] == "1"
local status = available and "Available" or "Logged Out"
-- S5-14: OpenSIPs' SIP listener (e.g. `opensips:5060`), passed by
-- `buildAgentStatusDialplanDocument`. Phones register with OpenSIPs, not with
-- this node, and the directory has no dial-string, so `user/<agent>` could
-- never reach the agent's phone: the agent is dialed through OpenSIPs like
-- every other bridge (`xml.ts`'s `agentContact`, which callcenter.conf uses
-- too). An older dialplan that does not pass it keeps the old contact.
local opensipsUri = argv[3]
local contact = "user/" .. agentName
if opensipsUri ~= nil and opensipsUri ~= "" then
  contact = "{sip_route_uri=sip:" .. opensipsUri .. "}sofia/internal/" .. agentName
end

local api = freeswitch.API()
api:executeString("callcenter_config agent add '" .. agentName .. "' 'callback'")
api:executeString("callcenter_config agent set contact '" .. agentName .. "' '" .. contact .. "'")
api:executeString("callcenter_config agent set status '" .. agentName .. "' '" .. status .. "'")
