"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RoomManager } = require("../server/room-manager");
const { MemoryWalletManager } = require("../server/wallet-manager");
const { attachRoomHandlers } = require("../server/room-handlers");
const { attachGameHandlers } = require("../server/game-handlers");

function createHarness() {
  const roomManager = new RoomManager({ randomCode: () => "4827" });
  const walletManager = new MemoryWalletManager();
  const sockets = new Map();
  const emitted = [];
  const io = {
    connectionHandlers: [],
    on(event, handler) { if (event === "connection") this.connectionHandlers.push(handler); },
    to(target) {
      return { emit(event, payload) { emitted.push({ target, event, payload }); } };
    },
    in(target) {
      return {
        async fetchSockets() { return sockets.has(target) ? [sockets.get(target)] : []; },
        async socketsJoin(room) { const socket = sockets.get(target); if (socket) await socket.join(room); }
      };
    }
  };
  function connect(id) {
    const handlers = new Map();
    const socket = {
      id,
      data: {},
      joined: new Set(),
      sent: [],
      on(event, handler) { handlers.set(event, handler); },
      emit(event, payload) { this.sent.push({ event, payload }); },
      async join(room) { this.joined.add(room); },
      async trigger(event, payload = {}) {
        const handler = handlers.get(event);
        assert.ok(handler, "missing socket handler: " + event);
        return handler(payload);
      },
      async disconnect() { return handlers.get("disconnect")?.(); }
    };
    sockets.set(id, socket);
    for (const handler of io.connectionHandlers) handler(socket);
    return socket;
  }
  attachRoomHandlers(io, roomManager, walletManager);
  attachGameHandlers(io, roomManager, walletManager);
  return { roomManager, walletManager, connect, emitted };
}

async function createAcceptedRoom(harness) {
  const host = harness.connect("host-socket");
  const guest = harness.connect("guest-socket");
  await host.trigger("identity:register", { username: "HostPlayer" });
  await guest.trigger("identity:register", { username: "GuestPlayer" });
  const hostIdentity = host.sent.find((entry) => entry.event === "identity:ready").payload;
  const guestIdentity = guest.sent.find((entry) => entry.event === "identity:ready").payload;

  await host.trigger("room:create");
  await guest.trigger("room:join", { code: "4827" });
  const request = harness.emitted.find((entry) => entry.target === host.id && entry.event === "room:join-request").payload;
  await host.trigger("room:respond", { code: "4827", requestId: request.requestId, accepted: true });

  return { host, guest, hostIdentity, guestIdentity };
}

test("full multiplayer wager lifecycle locks both wallets, starts PvP, and pays the server-declared winner", async () => {
  const harness = createHarness();
  const { host, guest, hostIdentity, guestIdentity } = await createAcceptedRoom(harness);

  await host.trigger("wager:propose", { code: "4827", stake: 200 });
  await guest.trigger("wager:respond", { code: "4827", accepted: true });

  let room = harness.roomManager.get("4827");
  assert.equal(room.wager.status, "locked");
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).balance, 800);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).balance, 800);

  await host.trigger("game:start", { code: "4827" });
  room = harness.roomManager.get("4827");
  assert.equal(room.status, "playing");
  assert.equal(room.game.status, "playing");

  await harness.roomManager.update("4827", (current) => {
    current.game.turnPlayerId = host.id;
    current.game.players.find((player) => player.id === guest.id).health = 1;
    current.game.chamber = ["live"];
    current.game.liveRemaining = 1;
    current.game.blankRemaining = 0;
    current.game.sawedOff = false;
  });
  await host.trigger("game:action", { code: "4827", action: { type: "shoot", target: "opponent" } });

  room = harness.roomManager.get("4827");
  assert.equal(room.game.status, "finished");
  assert.equal(room.game.winnerId, host.id);
  assert.equal(room.wager.status, "settled");
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).balance, 1200);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).balance, 800);
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).locked, 0);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).locked, 0);
});

test("disconnect before the match refunds both locked stakes", async () => {
  const harness = createHarness();
  const { host, guest, hostIdentity, guestIdentity } = await createAcceptedRoom(harness);

  await host.trigger("wager:propose", { code: "4827", stake: 150 });
  await guest.trigger("wager:respond", { code: "4827", accepted: true });

  const locked = harness.roomManager.get("4827");
  assert.equal(locked.wager.status, "locked");
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).balance, 850);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).balance, 850);

  await host.disconnect();
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).balance, 1000);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).balance, 1000);
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).locked, 0);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).locked, 0);
});

test("disconnect during a locked match forfeits the pot to the connected opponent", async () => {
  const harness = createHarness();
  const { host, guest, hostIdentity, guestIdentity } = await createAcceptedRoom(harness);

  await host.trigger("wager:propose", { code: "4827", stake: 125 });
  await guest.trigger("wager:respond", { code: "4827", accepted: true });
  await host.trigger("game:start", { code: "4827" });
  await guest.disconnect();

  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).balance, 1125);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).balance, 875);
  assert.equal((await harness.walletManager.getAccount(hostIdentity.token)).locked, 0);
  assert.equal((await harness.walletManager.getAccount(guestIdentity.token)).locked, 0);
  assert.ok(harness.emitted.some((entry) =>
    entry.target === host.id && entry.event === "game:state" && entry.payload.status === "finished"
  ));
});
