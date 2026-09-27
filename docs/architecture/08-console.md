# 08 — Console (Flutter web)

## 1. Shape

- A single Flutter **web-only** app in `apps/console`. There are no native builds.
- Multi-page navigation is fine (SAD §9). `go_router` owns URL routes, and each top-level section is its own route tree. Deep links work, and a reload restores the page from the URL.
- One app serves all three roles. The shell shows sections according to `ot` (org type) and permissions in the token.
- The console talks **only** to api-gateway. The API client is generated from the merged OpenAPI spec (`openapi-generator`, `dart-dio`) into `apps/console/packages/console_api`.

**(Proposed)** libraries: `flutter_riverpod` (state), `go_router`, `dio`, `freezed`/`json_serializable` (models), and `web_socket_channel` (live feeds).

```
apps/console/
  lib/
    app/            bootstrap, router, theme, brand loader
    core/           api client wiring, auth/session, permissions, errors, realtime client
    features/
      auth/
      master/       resellers
      reseller/     tenants, domains, brand editor, trunks
      tenant/       users, extensions, dids, groups, queues, schedules, media
      callflow/     builder canvas
      monitoring/   presence board, live calls, barge/whisper/listen
      recordings/   (S5)  voicemail/ (S5)  analytics/ (S7)
    widgets/        shared design-system components (brand-agnostic)
  web/              index.html, manifest.json, icons: neutral only
  packages/console_api/   generated
```

## 2. Brand bootstrap and theming

1. `web/index.html` ships with a **neutral** `<title>`, no product name, a neutral favicon, and a neutral loading indicator. The Flutter template's defaults (project name, "A new Flutter project.") MUST be replaced and are covered by the brand-leak check.
2. Before `runApp`, `main.dart` calls `GET /v1/public/brand?host={window.location.host}`. The response is a reseller brand or `{neutral:true}`.
3. The app builds `ThemeData` from brand colors, or from the neutral grayscale palette with its system accent. Both must pass WCAG AA contrast, which is checked when a reseller saves a brand; the brand editor rejects failing color pairs.
4. It sets the document title and favicon through `package:web` interop, and uses the brand `display_name` in the header. When NEUTRAL, the header shows no product label.
5. After login, if the user's org resolves to a different brand than the hostname (for example, a reseller user signing in on the neutral hostname), the app reloads the theme for the session's org.

All design-system widgets take colors and logos from the theme and never embed an asset.

## 3. Navigation by role

| Org type | Sections |
|---|---|
| Master | Resellers · Operations (services, media nodes, SIP edge, events, data stores; [11](11-operations-console.md)) · Audit · Users |
| Reseller | Tenants · Trunks (per tenant) · Domains · Brand · Users · Audit |
| Tenant | Dashboard · Users · Extensions · Phone numbers · Call flows · Ring groups · Queues · Schedules · Media · Monitoring · Recordings · Voicemail · Reports · Settings |

The master can do everything a reseller can, for any reseller: a reseller's own page has Tenants, Trunks, Domains and Brand tabs, and the master reaches it from Resellers. (There is no separate master Trunks or Domains entry, since those belong to one reseller.)

Master and reseller users can **enter** a descendant org ("act as tenant"). The shell shows a persistent banner, and every request carries the target org in the path, so no token swap is needed.

Private-data sections are hidden for resellers (H1). The server enforces this independently.

## 4. Call-flow builder

The interaction model is like React Flow, implemented natively in Flutter.

### 4.1 Architecture

- **Model:** `FlowGraph { nodes: Map<id, FlowNode>, edges: List<Edge>, viewport }`. `FlowNode { id, type, position, config, ports }`. `Edge { fromNode, fromPort, toNode }` (input ports are implicit, one per node).
- **Rendering:** an `InteractiveViewer`-style pan/zoom (a custom `Transform`-based viewport for finer control) containing:
  - a `CustomPainter` layer for the grid and the edges (cubic Béziers, hit-testable by sampling)
  - a `Stack` of positioned node widgets (regular widgets, so they support text, forms, and focus)
  - an overlay layer for the connection being dragged and the selection marquee
- **Interactions:** drag a node from the palette; move nodes (snap to grid); drag from an output port to a node to connect; select one or many (click, shift-click, marquee); delete; copy and paste; undo and redo (command stack); zoom to fit; minimap (later).
- **Properties panel:** the right-side panel shows the typed form for the selected node, generated from the node type's config schema.
- **Validation:** runs locally on every change using rules ported from `@cuc/callflow-ir`. It covers unconnected required ports, unreachable nodes, missing references, and menu digit conflicts. The server's `:validate` endpoint is authoritative. Issues are shown as badges on nodes and in an issues list.
- **Versioning UI:** draft autosave (debounced PUT), a publish button with a diff summary (nodes added, removed, or changed), a version history list, and rollback.
- **Performance target:** 150 nodes at 60 fps pan and zoom on a mid-range laptop in Chrome.

### 4.2 Node palette (MVP)

Play · Menu (IVR) · Time condition · Extension · Ring group · Queue · Voicemail · Go to flow · Hangup. These match IR MVP node types ([03 §4](03-signaling-and-media.md#4-call-flows-ivr--auto-attendant)).

## 5. Live monitoring

- A WebSocket connection to api-gateway `/v1/ws`, where the client subscribes to topics: `tenant:{t}:presence`, `tenant:{t}:calls`, `tenant:{t}:queues`. The gateway filters by permission.
- **Presence board:** a grid of extensions showing state (idle, ringing, on call, DND, offline). Sources are call-control events plus registration state.
- **Live calls:** a table of the tenant's active calls with duration, parties, and queue. When permitted for that target, the row offers actions: **Listen / Whisper / Barge**.

**As built (S5-08).** `lib/core/realtime.dart` holds the client: one connection per signed-in session to `/v1/ws` on the API's origin (the page's own, unless `API_BASE_URL` says otherwise), opened on first use. It sends the access token as its first message (never in the URL), hands over each token the session refreshes (a minute before expiry) on the open connection, and subscribes to every topic being watched. When the connection drops it reconnects after 1 s doubling to 30 s, with jitter, and subscribes again, so each topic gets a fresh snapshot; topics the gateway calls `unavailable` are retried the same way, refusals are not, and a 4403 close stops it until the next sign-in. `realtimeClientProvider` gives the client, `realtimeConnectorProvider` the socket (the browser's `WebSocket` through `package:web`, or demo mode's canned one in `lib/dev/demo_realtime.dart`), and a stream from `client.watch(topic)` is a subscription for as long as it is listened to.

The Monitoring page (`lib/features/monitoring/`) shows **Live calls**: the tenant's calls from the `calls` topic (the two bridged legs of a call as one row, caller first), with state, a running duration and whether it is being recorded. It is shown to holders of `monitor.calls` and never to a reseller (H1), and leaving the page unsubscribes. The queue column is still to come.

**Recording buttons (S5-15, G-111 (3), G-120).** A person holding `recording.control` (never a reseller) gets an **Actions** column with the buttons each call allows, by the same rules as the in-call feature codes `*1`/`*2` (`recordingActionsFor` in `lib/features/monitoring/recording_controls.dart`): with `controls: on_demand`, **Record** when not recording, **Stop** and **Pause** while recording, **Stop** and **Resume** while paused; with `controls: pause` (a rule recording), **Pause** or **Resume** only, never Stop; nothing otherwise. The Recording column reads Recording, Paused or —. A press calls `POST /v1/tenants/{t}/calls/{leg}/recording` with `{action}`; the row shows the press as pending ("Starting…", "Pausing…") until the live feed shows the call's recording in another state than when pressed, so the screen never claims a state the call is not in (a press with no change after 15 s gives the buttons back). A refusal or failure is a snackbar in the service's own neutral words. The table scrolls sideways when the buttons make it wider than the window.

**My phone (S5-15).** Every My phone screen starts with a card for each call the person is on now (`lib/features/myphone/my_live_calls.dart`), from their own calls topic `tenant:{t}:user:{u}:calls` (`self.history`): who it is with, how long, and whether it is recorded or paused, with the same buttons for a holder of `self.recording`, calling `POST /v1/tenants/{t}/me/live-calls/{leg}/recording` on the person's own leg. No call, or no live connection, shows nothing.

**As built (S5-10): presence board.** Above Live calls, a **Presence** section (`lib/features/monitoring/presence.dart`, `presence_board.dart`) shows a tile per extension from the `presence` topic (`monitor.presence`, which every tenant user holds): the snapshot `{extensions: [{extension, state}]}` lists every extension of the tenant, sorted by number, and each `presence.changed` event `{extension, state}` updates one (an extension only an event names is added). The states are `idle` (a phone is registered and not on a call), `ringing`, `on_call`, `dnd` and `offline` (no phone registered), shown as Available, Ringing, On a call, Do not disturb and Offline, each with its own icon and color so none is told apart by color alone; a state the console does not know is shown as it comes, in neutral, never refused. A holder of `extension.read` sees each extension's name beside its number (from the same extension list the other screens use); anyone else sees numbers only. Presence is `config` data, so the board is shown to a holder of `monitor.presence` without `monitor.calls` (the Live calls section then says the role does not include them), and to a reseller inside a tenant whose role holds it; leaving the page unsubscribes. The board takes up to a third of the page's height above the calls table and scrolls beyond that.

**Calls you can monitor (G-119 (1)).** Live calls are shown to a holder of `monitor.calls` (every call of the tenant, from `tenant:{t}:calls`) and, since G-119 (1), to anyone who may listen, whisper or barge, perhaps only on some extensions or queues: without `monitor.calls` the section is titled "Calls you can monitor" and fed by their own `tenant:{t}:user:{u}:supervised` topic, which the hub limits to the calls their grants reach (the calls of those extensions, those queues and those queues' agents, with the legs bridged to them). The table, its buttons and its rules are otherwise the same. Never a reseller (H1).

**As built (S5-10): Listen, Whisper and Barge.** The Actions column also carries **Listen**, **Whisper** and **Barge** (`lib/features/monitoring/monitor_controls.dart`) on answered and held calls (the service refuses a ringing one), each shown to a holder of its own permission (`monitor.listen`, `monitor.whisper`, `monitor.barge`; `private`, so never to a reseller, H1). A press calls `POST /v1/tenants/{t}/calls/{leg}/listen`, `/whisper` or `/barge` on either leg of the call, with no body: the phone rung is always the signed-in person's own linked extension, taken from their identity, and the service joins it to the tenant's own party on the call (no in-browser audio, O-14; each action is audited by call-control). The request returns only once that phone has answered (up to the service's 30 s ring timeout), so the console waits up to 60 s for it, and meanwhile the row shows "Ringing your phone…" in place of its monitor buttons. api-gateway waits for these three routes up to `PROXY_MONITOR_TIMEOUT_MS` (45 s) rather than its usual 15 s, so a phone answered late is not reported as a timeout. On success a snackbar says "Listening on your phone", "Whispering on your phone" or "Barged in on your phone"; a refusal (`call_not_found`, `no_linked_extension`, `own_call`, `phone_not_answered`, …) is a snackbar in the service's own neutral words. `/v1/orgs/{o}/me` lists a permission held only as a grant on an extension or a queue as well, so such a person is shown the buttons on every call and the service refuses a call outside the grant (403 `insufficient_permission`, a snackbar). The supervisor's own leg to their phone then appears in the feed like any other leg on their extension.

**Demo.** `lib/dev/demo_realtime.dart` gives the internal call `controls: on_demand` and the recorded outbound call `controls: pause`, and `demoRecordingAction` (called by the demo backend) applies the same rules and pushes the change to every open demo socket 0.4 s later, so the pending state can be seen. Its presence snapshot (`demoPresence`) has extensions in all five states. `demoMonitorAction` answers the monitor routes 200 after 1.5 s for an answered or held call (409 `call_not_answered` for the ringing one), so "Ringing your phone…" can be seen; sign in as `supervisor@…` (the `tenant_supervisor` role) to get the buttons, since `tenant_admin` does not hold the monitor permissions.
