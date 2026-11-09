# Buckshot Roulette — Browser CLI

A browser recreation of Buckshot Roulette with a single-player game and an in-progress online multiplayer foundation.

## Run locally

Requires Node.js 20 or later.

```sh
npm install
npm start
```

Open http://localhost:3000. Multiplayer requires the app to be served by this Node.js server; opening `index.html` directly only supports the existing single-player game.

## Multiplayer foundation

The current multiplayer milestone includes:
- Browser-persisted display usernames (3–16 letters, numbers, underscores or hyphens).
- Four-digit room creation.
- Joining requests that require host approval.
- In-memory room lifecycle and inactive-room expiration.
- Express + Socket.IO server.
- Automated room-manager tests.

Rooms currently live in server memory. Restarting the server clears them. The lobby is a foundation only: PvP gameplay, server-authoritative ammunition and item logic, and the 60-second reconnect flow are not implemented yet.

## Tests

```sh
npm test
```

The original single-player rules-engine tests remain in place.
