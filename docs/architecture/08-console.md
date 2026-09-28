# 08 — Console (Flutter web)

The console is where every person who runs a phone system, from the platform's operator to someone checking their own voicemail, does it. Stage 9 rebuilt it around one idea: **someone who knows nothing about telephony can set up and run their phones, and an expert loses none of the power.** Plain words by default, the technical choices one click away, and every screen translatable.

## 1. Shape

- A single Flutter **web-only** app in `apps/console`; no native builds. `go_router` owns the URLs, so deep links work and a reload restores the page (and the tenant being acted as, `?as=`).
- One app serves every role. The navigation comes from the signed-in person's org type and permissions (`/v1/orgs/{o}/me`); the server enforces them independently.
- The console talks **only** to api-gateway, through a client generated from the merged OpenAPI spec (`openapi-generator`, `dart-dio`) into `packages/console_api`, and to its realtime hub over one WebSocket.
- Libraries: `flutter_riverpod` (state), `go_router`, `dio`, `flutter_localizations` + `intl` (strings, `gen-l10n`), `package:web` (browser interop), `fl_chart` (operations charts), `qr_flutter` (phone provisioning).

```
apps/console/lib/
  app/        bootstrap, router, theme (light and dark), brand loader
  core/       api client, session, permissions (`/me`), problems, realtime client,
              acting as a tenant, locale and appearance, browser interop (files, audio,
              time zone, local storage)
  forms/      validators and formatters (phone numbers, MACs, email, digits)
  widgets/    the component kit: AppTable, EditorPage, EmptyState, confirmations,
              toasts, page frame and header
  canvas/     the call flow canvas (pan, zoom, nodes, edges)
  l10n/       app_en.arb and the generated AppLocalizations
  features/   one folder per area (people, pbx, callflow, monitoring, attendant,
              myphone, orgs, platform, …)
  dev/        demo mode: a backend and a realtime hub answering with canned data
web/          index.html, manifest and icons: neutral only
packages/console_api/   generated
```

## 2. Ease of use

The rules every screen follows (S9-02 to S9-08):

- **Plain language.** Screens say what a thing does ("Send calls to", "Rings for 20 seconds"), not what the switch calls it. The telephony terms stay in an **Advanced** section of each form, closed by default.
- **Tasks, not tables of parts.** A person is one screen (People: their extension, voicemail and desk phone together, S9-07); a main number is set up by answering questions (S9-09), not by drawing a flow; a new tenant is a three-step wizard (S9-16). The parts stay reachable for those who want them: Call flows under *Calls*, Extensions and Phones under *Advanced*.
- **Forms that help.** Fields check as you leave them and say what is wrong in words; phone numbers are read in the tenant's country and shown the way people write them; a choice that needs something that does not exist yet can create it in place (S9-04).
- **Tables that scale** (`AppTable`, S9-03): search, sort, paging, bulk actions, and an empty state that says what the list is for and offers the first one.
- **Safe changes.** Deleting asks, and says what else uses the thing and what will happen (`usedBy`); a change that can be undone says so in a toast with **Undo**.
- **Errors in words.** Every service problem carries a stable `code` (S9-02); the console has words for the ones people meet (`lib/l10n/problems.dart`) and shows the service's own neutral text for the rest. Field errors go next to their fields.

## 3. Brand, appearance and language

1. `web/index.html` ships with a **neutral** `<title>`, favicon and loading indicator; no product name anywhere (CLAUDE.md rule 1, checked by `tools/brand-leak`).
2. Before `runApp`, `main.dart` asks `GET /v1/public/brand?host=…` for the hostname's brand (a reseller's, or neutral). After sign-in the session's own org brand replaces it when different.
3. `buildTheme` makes a light and (S9-17) a dark theme from the brand's colors or the neutral grayscale palette. Brand color pairs must pass WCAG AA, checked when a reseller saves them. In dark mode the palette is generated from the brand's color, keeping its hue, and the brand's own colors are used only where they stand out from the dark surface (3:1).
4. **Appearance** in the account menu: as on this device (default), light or dark, remembered in the browser. **Language** likewise: the browser's, until the person chooses.
5. **Every string is in `lib/l10n/app_en.arb`** (S9-01, S9-17). Widgets read `context.l10n`; code without a `BuildContext` reads `currentL10n`. ICU plurals and selects carry counts and choices. `tool/check-strings.mjs` fails a change that adds a user-facing literal to Dart; what is left in code (5 literals) is protocol and product names. Translations are added as `app_<locale>.arb` files.

## 4. Navigation

The shell (S9-05): a navigation rail grouped under headings, a drawer below 720 px, and an account menu (who you are and where, change password, language, appearance, support, sign out).

| Org type | Sections |
|---|---|
| Master | Dashboard · *Platform:* Resellers, Operations ([11](11-operations-console.md)), Certificates, Security · Audit · Users |
| Reseller | Dashboard · *Customers:* Tenants · *Service:* Trunks, Domains, Brand · Users · Audit |
| Tenant | Dashboard · *People:* People · *Calls:* Phone numbers, Call flows, Ring groups, Pickup groups, Queues, Schedules, Conference rooms, Parking lots, Media, Outbound routes · *Activity:* Attendant, Monitoring, Call records, Recordings, Voicemail · *Settings:* Emergency locations · Users · *Advanced:* Extensions, Phones |
| A person with only a phone | Home · My call handling · My voicemail · My call history |

- A master or reseller **acts as** a tenant (the tenant switcher, or **Act as** on a tenant): the shell shows whose console it is and a way back, every request names that tenant in its path, and the URL keeps it (`?as=`). Private-data sections are hidden from a reseller (H1).
- An administrator who also has a phone gets **My phone** under *You*, with the same screens as tabs.

## 5. Homes and setup

- **A tenant's home** (S9-06, `tenant_home.dart`): the setup checklist in order (add people, connect a phone, get a number, decide how it is answered), what needs attention (numbers that ring nowhere, unpublished flows, media that failed), recent calls, and the figures.
- **A reseller's and the master's home** (S9-16, `org_home.dart`): what needs them, each item leading to the screen that deals with it, from lists those screens already read, never estimated (reseller: no tenants, suspended tenants, no brand, domains not verified, certificates that cannot be renewed; master: services not ready, media servers out of service, two-step verification off, failing certificates, resellers). Then the main action and the figures.
- **Setting up a new tenant** (S9-16, `new_tenant_page.dart`, `/tenants/new` or `/resellers/{id}/new-tenant`): who they are, their administrator (a password made up for them), a last look; then the sign-in details and **Set up their phone system**, which acts as the tenant and opens its checklist.
- **People** (S9-07): one screen per person with their extension, voicemail, desk phone and sign-in, saved part by part so a failure says which part.
- **Setting up the main number** (S9-09, `/phone-numbers/setup`): open hours, who answers (a person, a group, or a menu of either), and where calls go when closed or unanswered; it becomes an ordinary call flow the builder can open later.

## 6. Call flows

The list (S9-10, `flows_page.dart`): which flows are live and which numbers each answers; new from a template (blank, open hours, a menu), rename, copy, delete (refused while a number uses it). Resellers build them too (D-020).

The builder, like React Flow, implemented natively in Flutter (`lib/canvas/`, `lib/features/callflow/builder/`). The canvas stays left to right in every language: a flow is a diagram with saved positions.

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

## 7. Live calls

**As built (S5-08).** `lib/core/realtime.dart` holds the client: one connection per signed-in session to `/v1/ws` on the API's origin (the page's own, unless `API_BASE_URL` says otherwise), opened on first use. It sends the access token as its first message (never in the URL), hands over each token the session refreshes (a minute before expiry) on the open connection, and subscribes to every topic being watched. When the connection drops it reconnects after 1 s doubling to 30 s, with jitter, and subscribes again, so each topic gets a fresh snapshot; topics the gateway calls `unavailable` are retried the same way, refusals are not, and a 4403 close stops it until the next sign-in. `realtimeClientProvider` gives the client, `realtimeConnectorProvider` the socket (the browser's `WebSocket` through `package:web`, or demo mode's canned one in `lib/dev/demo_realtime.dart`), and a stream from `client.watch(topic)` is a subscription for as long as it is listened to.

**Monitoring** (`lib/features/monitoring/`): the presence board, the queues (S9-15: waiting callers, the longest wait, each agent's status) and the live calls with a Queue column. Live calls are shown to holders of `monitor.calls`, never to a reseller (H1).

**As built (S5-10): presence board.** Above Live calls, a **Presence** section (`lib/features/monitoring/presence.dart`, `presence_board.dart`) shows a tile per extension from the `presence` topic (`monitor.presence`, which every tenant user holds): the snapshot `{extensions: [{extension, state}]}` lists every extension of the tenant, sorted by number, and each `presence.changed` event `{extension, state}` updates one (an extension only an event names is added). The states are `idle` (a phone is registered and not on a call), `ringing`, `on_call`, `dnd` and `offline` (no phone registered), shown as Available, Ringing, On a call, Do not disturb and Offline, each with its own icon and color so none is told apart by color alone; a state the console does not know is shown as it comes, in neutral, never refused. A holder of `extension.read` sees each extension's name beside its number (from the same extension list the other screens use); anyone else sees numbers only. Presence is `config` data, so the board is shown to a holder of `monitor.presence` without `monitor.calls` (the Live calls section then says the role does not include them), and to a reseller inside a tenant whose role holds it; leaving the page unsubscribes. The board takes up to a third of the page's height above the calls table and scrolls beyond that.

**Calls you can monitor (G-119 (1)).** Live calls are shown to a holder of `monitor.calls` (every call of the tenant, from `tenant:{t}:calls`) and, since G-119 (1), to anyone who may listen, whisper or barge, perhaps only on some extensions or queues: without `monitor.calls` the section is titled "Calls you can monitor" and fed by their own `tenant:{t}:user:{u}:supervised` topic, which the hub limits to the calls their grants reach (the calls of those extensions, those queues and those queues' agents, with the legs bridged to them). The table, its buttons and its rules are otherwise the same. Never a reseller (H1).

**Recording buttons (S5-15, G-111 (3), G-120).** A person holding `recording.control` (never a reseller) gets an **Actions** column with the buttons each call allows, by the same rules as the in-call feature codes `*1`/`*2` (`recordingActionsFor` in `lib/features/monitoring/recording_controls.dart`): with `controls: on_demand`, **Record** when not recording, **Stop** and **Pause** while recording, **Stop** and **Resume** while paused; with `controls: pause` (a rule recording), **Pause** or **Resume** only, never Stop; nothing otherwise. The Recording column reads Recording, Paused or —. A press calls `POST /v1/tenants/{t}/calls/{leg}/recording` with `{action}`; the row shows the press as pending ("Starting…", "Pausing…") until the live feed shows the call's recording in another state than when pressed, so the screen never claims a state the call is not in (a press with no change after 15 s gives the buttons back). A refusal or failure is a snackbar in the service's own neutral words. The table scrolls sideways when the buttons make it wider than the window.

**As built (S5-10): Listen, Whisper and Barge.** The Actions column also carries **Listen**, **Whisper** and **Barge** (`lib/features/monitoring/monitor_controls.dart`) on answered and held calls (the service refuses a ringing one), each shown to a holder of its own permission (`monitor.listen`, `monitor.whisper`, `monitor.barge`; `private`, so never to a reseller, H1). A press calls `POST /v1/tenants/{t}/calls/{leg}/listen`, `/whisper` or `/barge` on either leg of the call, with no body: the phone rung is always the signed-in person's own linked extension, taken from their identity, and the service joins it to the tenant's own party on the call (no in-browser audio, O-14; each action is audited by call-control). The request returns only once that phone has answered (up to the service's 30 s ring timeout), so the console waits up to 60 s for it, and meanwhile the row shows "Ringing your phone…" in place of its monitor buttons. api-gateway waits for these three routes up to `PROXY_MONITOR_TIMEOUT_MS` (45 s) rather than its usual 15 s, so a phone answered late is not reported as a timeout. On success a snackbar says "Listening on your phone", "Whispering on your phone" or "Barged in on your phone"; a refusal (`call_not_found`, `no_linked_extension`, `own_call`, `phone_not_answered`, …) is a snackbar in the service's own neutral words. `/v1/orgs/{o}/me` lists a permission held only as a grant on an extension or a queue as well, so such a person is shown the buttons on every call and the service refuses a call outside the grant (403 `insufficient_permission`, a snackbar). The supervisor's own leg to their phone then appears in the feed like any other leg on their extension. Since D-021 tenant administrators hold Listen, Whisper and Barge as supervisors do.

**Attendant console** (S9-14, G-127, `/attendant`): for holders of `call.control` who also watch live calls. Every call the receptionist takes part in rings their own phone (O-14).

- **Calls**, sorted into Incoming, Waiting in a queue, Parked (from `mod_valet_parking`'s own events, so a call parked from a phone shows too) and In progress: **Send to…**, **Park**, **Pick up on my phone**, **Hang up** (after asking). A card can be dragged.
- **Directory**: every extension with its state and name, searchable. Drop a call on one to send it there (at once, blind); with a call chosen, a tap does the same. **Call** places a call from the receptionist's phone.
- **Parking lots**: drop a call on one to park it; **Take back** dials the slot.
- **Queues**: as on Monitoring, with each agent's status changeable (sign in, a break, sign out).
- **Keyboard**: `/` search, `↑`/`↓` choose, `T` send to, `Enter` in the search sends to the first match, `P` park, `A` pick up, `H` hang up, `Esc`, `?` the list.
- On a narrow screen the page scrolls as one column.

## 8. A person's own phone

The end-user portal (S9-11, `lib/features/myphone/`), everything a person with only `self.*` permissions sees:

- **Home**: their number; one switch that forwards every call to their mobile (the rest of their call handling kept); new messages and their greeting (record it with the microphone, as WAV, or upload one); their last calls; **Connect a phone or app** (server, port, and their own username and password on request, audited).
- **Calls you can pick up** (S9-18): a colleague's phone ringing within their pickup groups, with **Pick up**, refreshed when presence changes; or they dial `*8`.
- **My call handling**, **My voicemail**, **My call history** (searchable by number or name).
- A card for each call they are on now, with the recording buttons their permissions allow; transfer, park and click-to-call are available over `/me` (S9-12) for the screens to use.

## 9. Accessibility and layout

- Every control has a name for screen readers: icon buttons by their tooltips, table checkboxes by their row ("Select 101 Alice"). No state is told by color alone (presence has a word and an icon).
- Text meets WCAG AA contrast in light and dark; status colors take the shade that reads on the background.
- Layout uses start and end, not left and right, so a right-to-left language mirrors it; `forcedTextDirectionProvider` previews it.
- Narrow screens: the navigation becomes a drawer, page headers put their buttons under the title, tables scroll sideways, and long pages scroll as one column.
- `test/accessibility_test.dart` checks labeled controls and text contrast on the main screens of a tenant administrator, a person and the master in light and dark, and lays them out right to left at 1280 and 400 px without overflow.

## 10. Demo mode and tests

- `--dart-define=DEMO=true` runs the console against `lib/dev`: a backend that answers every route the screens use with believable data and the same rules as the services, and a realtime hub that acts out live calls, parking, pickup, transfers and queues. The widget tests use it too.
- `test/`: widget tests per area, golden images of the sign-in and the shell (neutral, branded, dark), a contract test against the OpenAPI spec and the problem codes the services send (`api/problem-codes.json`), and the accessibility test above.
