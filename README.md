# Gridlock: Storm Chasers

A zero-login, real-time browser game for 2–8 players. Chase telemetry across three storms, then extract before a repeated hazard wipes your unbanked score.

## Run

Use Node.js 22 or newer. In this directory:

```sh
npm ci
npm start
```

Open **http://localhost:3000**. Create a room, then join its four-letter code from another browser tab or device. For devices on the same network, open `http://YOUR_COMPUTER_LAN_IP:3000` and allow incoming connections on that port. Browser sessions are tab-scoped, so separate tabs can act as separate players.

```sh
npm test        # game rules and real Socket.IO client/server integration tests
npm run dev    # restart the server when source files change
```

There is no frontend build step, database, account system, CDN dependency, or external asset dependency. Only the first dependency installation needs the npm registry.

## Architecture and modular stages

1. **Game engine — `server/game.js`.** Deck generation, card reveals, scoring, hidden choices, resolution, storm reset, and sanitized public snapshots. No Express or Socket.IO imports. Shuffling uses crypto-backed Fisher–Yates.
2. **Rooms and transport — `server/app.js`.** Express serves `public/`; Socket.IO attaches to the same HTTP server. A process-local `Map` stores rooms. This module owns connection identity, capacity, host authority, deadline scheduling, automatic phase progression, and abandoned-room cleanup. `server.js` starts and stops the process; `server/index.js` remains a compatibility shim.
3. **Responsive client — `public/`.** Vanilla HTML, CSS, and ES modules render lobby, mission, and results views. The client submits intentions and renders the server snapshot; it never calculates authoritative scores or draws cards. Names are inserted with `textContent`.
4. **Verification — `test/`.** The engine tests cover scoring invariants and edge cases. Integration tests connect actual Socket.IO clients to an ephemeral HTTP server.

## State flow

`LOBBY → DECISION → TURN_SUMMARY → DECISION … → STORM_END`

After `STORM_END`, the server starts the next storm, or enters `GAME_OVER` after Storm 3. A matching second hazard goes directly from the internal reveal action to `STORM_END`.

`REVEAL_CARD` is an internal action, not a client command or public phase. Every public transition and choice lock emits `state_update`; countdown changes emit it once per displayed second. State contains the requested schema plus `cardsRemaining`, `bustRiskPercent`, `stormBusted`, `stormLosses`, `turnNumber`, and a monotonically increasing `turnId` for rejecting stale choices, including across rematches. `currentCard` is null in the lobby; hazards have no numeric value. No deck order, session tokens, socket IDs, or private choices appear in public snapshots. During `DECISION`, all public `lastChoice` values are null.

## Rules and explicit defaults

- Each storm gets a fresh shuffled 15-card deck: values 10, 15, 20, 25, 30, 35, 40, 50, 60; two each of Lightning Strike, EMP Surge, and Tornado Vortex.
- Telemetry is divided by the number of ACTIVE crews. Integer shares go to their unbanked scores; the remainder accumulates in salvage.
- Each non-busting hazard adds **8 points** of Damaged Drone Salvage to the cache. A bust awards no salvage.
- Live bust risk is `Math.round(uniqueActiveHazardsCount / cardsRemaining * 100)`. It is zero with an empty deck or after a storm ends, when no next draw is available. The client displays the remaining deck and next-draw risk.
- On a bust, `stormLosses` captures each active crew's `{ id, name, lostPoints }` before resetting unbanked scores. `stormBusted` and losses reset at the next storm.
- Decisions are immutable once locked. Choosing EXTRACT does not change status or bank anything until simultaneous resolution, keeping choices secret.
- Exactly one extractor on a turn receives all accumulated salvage. Multiple extractors bank their own points, leaving salvage behind. If everyone extracts together, unclaimed salvage is discarded when the next storm begins.
- At the 15-second server deadline, missing decisions become EXTRACT. A previously locked PUSH remains PUSH even if its player disconnects.
- Continuing turns show a 2-second summary before the next card. If the final active crew extracts, resolution goes directly to STORM_END, preserving all revealed choices and skipping the summary countdown.
- Both safe and busted storm-end results remain visible for 3 seconds, then the next storm starts automatically. Banked scores carry forward. The highest score after three storms wins; ties share victory.
- A disconnected active crew remains in the current storm and is subject to the same deadline and hazard rules. Crews offline when a new storm starts sit out that storm as EXTRACTED. Reconnecting does not re-enter a storm they have left.
- Host authority transfers immediately to the first connected crew when the host disconnects or leaves. A returning former host does not displace the new host.
- Joining is lobby-only. Launch and rematch require at least two connected crews. Starting removes offline seats and resets all banked scores; a normal next storm preserves them.
- Rematch uses the same room code and connected roster. A player who leaves mid-game remains in the standings but cannot resume using the invalidated token.
- Rooms with no connected players expire after 2 minutes. A process restart loses all rooms, as required by the in-memory design.
- Deck exhaustion is mathematically unreachable with active players under the specified deck: a repeated hazard must occur first. A defensive fallback banks remaining telemetry and discards salvage if a custom deck is exhausted.

## Socket protocol

Every request takes an object and an acknowledgement callback. Success is `{ ok: true, ... }`; rejection is `{ ok: false, error: "message" }`.

| Client event | Payload | Purpose |
| --- | --- | --- |
| `create_room` | `{ name }` | Create a room and become host |
| `join_room` | `{ name, roomCode }` | Join a lobby, up to eight seats |
| `resume_session` | `{ roomCode, token }` | Restore an existing offline identity |
| `start_game` | `{}` | Host-only launch or rematch |
| `submit_choice` | `{ choice: "PUSH" \| "EXTRACT", turnId }` | Lock one decision for this turn |
| `leave_room` | `{}` | Leave and invalidate the resume token |

Create/join/resume acknowledgements privately return `playerId`, `token`, `roomCode`, `state`, and `ownChoice`. The random 256-bit resume token is stored in `sessionStorage`. A Socket.IO socket ID is not used as the player's stable identity. The server never trusts a client-supplied player ID for scoring or authorization. Active sessions cannot be taken over from a second tab.

## Deployment

Deploy this folder to a **persistent, single-instance Node.js host** with WebSocket support. Install production dependencies with `npm ci --omit=dev` and start with `npm start`. Do not deploy only `public/`: multiplayer requires this server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and Socket.IO listening port |
| `PUBLIC_ORIGIN` | unset | Exact browser origin, e.g. `https://game.example.com`, without trailing slash; useful behind a reverse proxy |

The package start command is `node server.js`. The entry point reads `process.env.PORT || 3000` and binds to `0.0.0.0`; `/health` returns `{ "ok": true }`. Terminate HTTPS at your host or reverse proxy and forward WebSocket upgrades and ordinary HTTP requests to the same process. If `PUBLIC_ORIGIN` is unset, browser handshake origins must match the request Host header. Non-browser clients without an Origin header are allowed.

Use one replica. An in-memory Map is not shared across processes; sticky routing alone is not a complete replacement for shared game state. Deploys and restarts erase running matches. Avoid hosts that suspend the process between requests. This project has not been deployed to a public host.

Basic limits are included: 20-character names, unique names within a room, 4 KB Socket.IO messages, 40 acknowledged requests per socket per 10 seconds, and 500 rooms. These are application guardrails, not a comprehensive distributed abuse-control system.

## Usability pass

- Storm, turn, and deck are independent badges that wrap as whole units.
- At widths up to 900px, the mission uses one column and compact cards. The decision buttons, extraction preview, and server countdown stay in a fixed bottom bar while an active crew is deciding. Content reserves space below so the bar does not cover the final rows. Desktop keeps the two-panel field-console layout.
- Push has an explicit secondary line showing next-draw bust probability.
- Decision text distinguishes guaranteed telemetry from conditional solo salvage, including a zero-telemetry first turn.
- Each resolved extraction produces a server-owned player `extractionReceipt`: `{ stormNumber, turnNumber, telemetry, salvage, total, bankedTotal }`. It remains available through subsequent cards and reconnects, then resets at the next storm. `total` is the score gained on that extraction; `bankedTotal` includes earlier storms. Receipts never appear before simultaneous resolution.
- Gameplay rules, deck composition, score amounts, and the 15/2/3-second timers are unchanged by this usability pass.

## Validation delivered

26 automated tests pass, including full three-storm progression, host-only controls, private choices, room isolation, eight-player capacity, stale/duplicate rejection, disconnect/resume, timers, cleanup, and rematch. Static HTML/CSS and the local Socket.IO client are served in the HTTP integration checks. Client JavaScript passes Node's syntax check; a DOM-stub test exercises risk labels, extraction previews, receipt displays, input attributes, and action/status visibility. The root server.js was also launched with a custom PORT and returned a successful health check.

Visual browser QA and real-device testing were not available in the build environment. The UI includes mobile breakpoints, semantic controls, keyboard focus states, live status messages, horizontal scrolling for narrow scoreboards, and reduced-motion styling, but these still need a browser/device review before a public launch.

## Reference documentation

- https://expressjs.com/en/starter/installing/
- https://socket.io/docs/v4/server-initialization/
- https://socket.io/docs/v4/rooms/
- https://socket.io/docs/v4/server-options/

## Public deployment and cross-device acceptance

Deployment settings: Node web service; build `npm ci --omit=dev`; start `npm start`; health check `/health`; one instance. The repository root must be the folder containing package.json and server.js, not its parent. Commit package-lock.json; do not commit node_modules. Set PUBLIC_ORIGIN to the exact HTTPS origin if needed behind the host proxy.

For Render, select the Free instance deliberately if using a demo tier. Free instances can sleep after 15 minutes without inbound traffic and can restart; every process restart loses this game's in-memory rooms. Wake-up is typically about a minute. This package has not been publicly deployed or tested over cellular. See https://render.com/docs/free and https://render.com/docs/deploy-node-express-app.

Once deployed, run this acceptance pass:

1. Open the public HTTPS URL on desktop and a phone using cellular data. Create on desktop and join on the phone.
2. Confirm the timer, card, scores, and risk agree. Lock different choices; neither choice should reveal before resolution.
3. Extract alone and verify telemetry + salvage = the receipt total. Extract together on another turn; both salvage receipt lines must be zero.
4. Refresh the extracted player's tab. Confirm identity, score, and receipt return. Refresh an active player after locking a choice; it must remain locked.
5. Disconnect the host and confirm another connected player becomes host. Rejoin the former host without duplicating its seat.
6. Complete three storms and start a rematch. Scores and receipts should reset, with the same room code.
7. At widths 360, 390, 768, and 900 CSS pixels, confirm the dock is reachable without scrolling, badges do not split internally, and scoreboard rows can be reached above the dock. Check landscape and increased text size too.
8. Restart the service and confirm the expired session returns players to create/join with a clear message. Old rooms are not expected to survive.

Record public URL, devices, browser versions, and results before marking cross-network verification complete.
