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
    core/           api client wiring, auth/session, permissions, errors, ws hub
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
| Master | Resellers · Platform health (nodes, calls, queues backlog) · Audit · Users |
| Reseller | Tenants · Trunks (per tenant) · Domains · Brand · Users · Audit |
| Tenant | Dashboard · Users · Extensions · Phone numbers · Call flows · Ring groups · Queues · Schedules · Media · Monitoring · Recordings · Voicemail · Reports · Settings |

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
- An action calls `POST /v1/tenants/{t}/calls/{uuid}:monitor` with a mode and the supervisor's extension. The supervisor's **own phone rings**, and on answer they're connected in that mode (no in-browser audio, O-14). Each action is audited.
