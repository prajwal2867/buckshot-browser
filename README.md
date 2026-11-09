# Buckshot Roulette — Browser CLI

A browser recreation of Buckshot Roulette with a single-player game and an online multiplayer lobby.

## Run locally

Requires Node.js 20 or later.

```sh
npm install
npm start
```

Open http://localhost:3000. The local server uses an in-memory room manager, so local lobby testing does not require Redis.

## Vercel multiplayer setup

The frontend remains a static Vercel deployment. The multiplayer WebSocket endpoint runs as a Vercel Node.js Function at `/api/socket`.

Vercel Functions do not share process memory. Production rooms are therefore stored in Redis, and the Socket.IO Redis adapter relays events between Function instances.

1. In the Vercel project, open **Storage** or **Integrations** and install **Upstash for Redis**.
2. Link the Redis database to this Vercel project.
3. Make sure the project has a `REDIS_URL` environment variable containing the Upstash Redis connection URL (the `rediss://...` URL, not the REST URL/token pair).
4. Apply the variable to Production and Preview environments as needed.
5. Redeploy after adding or changing environment variables.

Never commit Redis credentials or expose them in browser code. The API function fails closed for multiplayer if `REDIS_URL` is missing; the static single-player game remains available.

The browser connects to the same-origin `/api/socket` endpoint using WebSocket transport. No separate socket-hosting provider is required.

## Current multiplayer scope

- Browser-persisted display usernames (3–16 letters, numbers, underscores or hyphens).
- Four-digit room creation.
- Join requests that require host approval.
- Redis-backed room state shared across Vercel Function instances.
- Redis-backed Socket.IO adapter for cross-instance event delivery.
- Room and socket membership updates are atomic Redis operations.
- Local development retains an in-memory room manager.

## PvP match rules

- The host starts a match after the second player is approved.
- Both players start with 4 health; the first turn is randomized.
- Each magazine contains 2–8 balanced live/blank shells. Players receive random items on reload, with an 8-item inventory cap.
- Players may shoot themselves or their opponent. A blank self-shot keeps the turn; other shots pass it. A player reaching 0 health loses immediately.
- All nine items are handled by the server: Magnifying Glass, Handcuffs, Beer, Cigarette Pack, Hand Saw, Adrenaline, Burner Phone, Inverter, and Expired Medicine.
- The server validates whose turn it is and every action. Redis stores the full match state; each client receives a filtered view, so chamber order and the other player's private shell knowledge are never sent to the browser.
- PvP state updates use an atomic compare-and-set in Redis to prevent two simultaneous actions from overwriting each other.

The 60-second reconnect flow is still a later phase. A Vercel deployment also needs its Upstash Redis integration configured before online matches can start.

## Tests

```sh
npm test
```

The CI workflow starts Redis and runs the Redis room-manager integration tests as well as the existing single-player and in-memory room-manager tests.