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

PvP gameplay, server-authoritative ammunition and item logic, and the 60-second reconnect flow are the next phases. A Vercel deployment also needs its Upstash Redis integration configured before the online lobby can create rooms.

## Tests

```sh
npm test
```

The CI workflow starts Redis and runs the Redis room-manager integration tests as well as the existing single-player and in-memory room-manager tests.