"use strict";

const crypto = require("node:crypto");
const { validateUsername } = require("./room-manager");
const { getPlayerView } = require("./pvp-engine");
const { MIN_STAKE, MAX_STAKE } = require("./wallet-manager");

function publicWager(wager) {
  if (!wager) return null;
  return {
    id: wager.id,
    stake: wager.stake,
    pot: wager.stake * 2,
    status: wager.status,
    hostAccepted: Boolean(wager.hostAccepted),
    guestAccepted: Boolean(wager.guestAccepted),
    winnerPlayerId: wager.winnerPlayerId || null
  };
}

async function emitWallet(io, walletManager, player) {
  if (!player) return;
  const account = await walletManager.getAccountById(player.playerId);
  if (account) io.to(player.socketId).emit("wallet:state", {
    balance: account.balance,
    locked: account.locked,
    username: account.username
  });
}

async function emitWager(io, room) {
  if (!room) return;
  io.to(room.code).emit("wager:state", publicWager(room.wager));
  await Promise.all([
    emitWallet(io, room.host, null),
    emitWallet(io, room.guest, null)
  ]);
}

function attachRoomHandlers(io, roomManager, walletManager) {
  io.on("connection", (socket) => {
    socket.on("identity:register", async (payload = {}) => {
      const username = String(payload.username || "").trim();
      if (!validateUsername(username)) {
        socket.emit("identity:error", { message: "Choose a username with 3–16 letters, numbers, underscores or hyphens." });
        return;
      }
      try {
        const registered = await walletManager.register({
          token: typeof payload.token === "string" ? payload.token : "",
          username
        });
        socket.data.player = {
          playerId: registered.account.id,
          username: registered.account.username,
          token: registered.token
        };
        socket.emit("identity:ready", {
          token: registered.token,
          username: registered.account.username,
          balance: registered.account.balance,
          locked: registered.account.locked
        });
      } catch (error) {
        socket.emit("identity:error", { message: error.message || "Could not load your multiplayer wallet." });
      }
    });

    socket.on("wallet:refresh", async () => {
      if (!socket.data.player) return;
      await emitWallet(io, walletManager, {
        socketId: socket.id,
        playerId: socket.data.player.playerId
      });
    });

    socket.on("room:create", async () => {
      const player = socket.data.player;
      if (!player) return socket.emit("room:error", { message: "Your multiplayer wallet is still loading. Please try again." });
      try {
        const room = await roomManager.create({
          socketId: socket.id, playerId: player.playerId, username: player.username
        });
        await socket.join(room.code);
        socket.emit("room:created", { code: room.code, host: { username: player.username }, status: room.status });
        await emitWallet(io, walletManager, { socketId: socket.id, playerId: player.playerId });
      } catch (error) {
        socket.emit("room:error", { message: error.message || "Could not create a room." });
      }
    });

    socket.on("room:join", async (payload = {}) => {
      const player = socket.data.player;
      if (!player) return socket.emit("room:error", { message: "Your multiplayer wallet is still loading. Please try again." });
      try {
        const result = await roomManager.requestJoin({
          socketId: socket.id,
          playerId: player.playerId,
          username: player.username,
          code: String(payload.code || "").trim()
        });
        if (!result.ok) return socket.emit("room:error", { message: result.error });
        socket.emit("room:join-pending", { code: result.code, hostUsername: result.hostUsername });
        io.to(result.hostSocketId).emit("room:join-request", {
          code: result.code, requestId: result.requestId, username: player.username
        });
      } catch {
        socket.emit("room:error", { message: "The room service is temporarily unavailable." });
      }
    });

    socket.on("room:respond", async (payload = {}) => {
      try {
        const result = await roomManager.respond({
          hostSocketId: socket.id,
          code: String(payload.code || ""),
          requestId: String(payload.requestId || ""),
          accepted: payload.accepted === true
        });
        if (!result.ok) return socket.emit("room:error", { message: result.error });
        if (result.accepted) {
          const guestSockets = await io.in(result.guestSocketId).fetchSockets();
          if (!guestSockets.length) {
            await roomManager.disconnect(result.guestSocketId);
            return socket.emit("room:error", { message: "That player disconnected before you could approve the request." });
          }
          await socket.join(result.code);
          await io.in(result.guestSocketId).socketsJoin(result.code);
          io.to(socket.id).emit("room:player-joined", {
            code: result.code,
            host: { username: result.host.username },
            guest: { username: result.guest.username }
          });
          io.to(result.guestSocketId).emit("room:joined", {
            code: result.code,
            host: { username: result.host.username },
            guest: { username: result.guest.username }
          });
          const room = await roomManager.get(result.code);
          await Promise.all([emitWallet(io, walletManager, room.host), emitWallet(io, walletManager, room.guest)]);
        } else {
          io.to(result.guestSocketId).emit("room:declined", { code: String(payload.code || "") });
          socket.emit("room:request-declined", { code: String(payload.code || "") });
        }
      } catch {
        socket.emit("room:error", { message: "Could not process that join request." });
      }
    });

    socket.on("wager:propose", async (payload = {}) => {
      const stake = Number(payload.stake);
      if (!Number.isSafeInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
        socket.emit("wager:error", { message: "Choose a whole-number stake between $10 and $1,000." });
        return;
      }
      try {
        let proposed = false;
        const room = await roomManager.update(String(payload.code || ""), (current) => {
          if (!current || current.status !== "lobby" || current.host?.socketId !== socket.id || !current.guest) return;
          if (current.wager?.status === "locked" || current.wager?.guestAccepted) return;
          current.wager = {
            id: crypto.randomUUID(),
            stake,
            hostPlayerId: current.host.playerId,
            guestPlayerId: current.guest.playerId,
            hostAccepted: true,
            guestAccepted: false,
            status: "proposed",
            createdAt: Date.now()
          };
          proposed = true;
        });
        if (!room || !proposed) return socket.emit("wager:error", { message: "You cannot change the wager at this stage." });
        io.to(room.code).emit("wager:state", publicWager(room.wager));
      } catch {
        socket.emit("wager:error", { message: "Could not create the wager. Please try again." });
      }
    });

    socket.on("wager:respond", async (payload = {}) => {
      const code = String(payload.code || "");
      let wagerToLock = null;
      let declined = false;
      try {
        const room = await roomManager.update(code, (current) => {
          if (!current || current.status !== "lobby" || current.guest?.socketId !== socket.id ||
              current.wager?.status !== "proposed" || current.wager.guestAccepted) return;
          if (payload.accepted === true) {
            current.wager.guestAccepted = true;
            wagerToLock = { ...current.wager };
          } else {
            current.wager.status = "declined";
            declined = true;
          }
        });
        if (!room || (!wagerToLock && !declined)) return socket.emit("wager:error", { message: "There is no pending wager to respond to." });
        if (declined) {
          io.to(code).emit("wager:state", publicWager(room.wager));
          return;
        }
        const locked = await walletManager.lockWager(wagerToLock);
        const updated = await roomManager.update(code, (current) => {
          if (current?.wager?.id === locked.id && current.status === "lobby") {
            current.wager.status = "locked";
            current.wager.lockedAt = locked.lockedAt || Date.now();
          }
        });
        if (!updated || updated.wager?.status !== "locked") {
          const refunded = await walletManager.refundWager(locked.id);
          const restored = await roomManager.update(code, (current) => {
            if (current?.wager?.id === refunded.id) {
              current.wager.status = "refunded";
              current.wager.guestAccepted = false;
            }
          });
          if (restored) {
            io.to(code).emit("wager:state", publicWager(restored.wager));
            await Promise.all([emitWallet(io, walletManager, restored.host), emitWallet(io, walletManager, restored.guest)]);
          }
          return socket.emit("wager:error", { message: "The room changed before the wager could be confirmed. Both stakes were refunded." });
        }
        io.to(code).emit("wager:state", publicWager(updated.wager));
        await Promise.all([emitWallet(io, walletManager, updated.host), emitWallet(io, walletManager, updated.guest)]);
      } catch (error) {
        let refunded = false;
        if (wagerToLock?.id) {
          try {
            const result = await walletManager.refundWager(wagerToLock.id);
            refunded = result.status === "refunded";
          } catch {
            // No escrow was created, or Redis is unavailable. Keep the match blocked.
          }
        }
        await roomManager.update(code, (current) => {
          if (current?.wager?.id === wagerToLock?.id) {
            current.wager.status = refunded ? "refunded" : "rejected";
            current.wager.guestAccepted = false;
          }
        }).catch(() => {});
        socket.emit("wager:error", { message: error.message || "Could not lock both stakes." });
        const latest = await roomManager.get(code).catch(() => null);
        if (latest) {
          io.to(code).emit("wager:state", publicWager(latest.wager));
          if (refunded) await Promise.all([emitWallet(io, walletManager, latest.host), emitWallet(io, walletManager, latest.guest)]);
        }
      }
    });

    socket.on("disconnect", async () => {
      try {
        const room = await roomManager.getRoomForSocket(socket.id);
        if (room?.wager?.status === "locked") {
          if (room.status === "lobby") {
            const refunded = await walletManager.refundWager(room.wager.id);
            await roomManager.update(room.code, (current) => {
              if (current?.wager?.id === refunded.id) current.wager.status = "refunded";
            });
            io.to(room.code).emit("wager:state", publicWager(refunded));
            await Promise.all([emitWallet(io, walletManager, room.host), emitWallet(io, walletManager, room.guest)]);
          } else if (room.status === "playing" && room.game?.status === "playing") {
            const winner = room.host.socketId === socket.id ? room.guest : room.host;
            await roomManager.update(room.code, (current) => {
              if (current?.game?.status === "playing") {
                current.game.status = "finished";
                current.game.winnerId = winner.socketId;
                current.game.pendingSteal = null;
                current.game.events.push({ message: "Opponent disconnected. " + winner.username + " wins by forfeit.", privateTo: null });
              }
            });
            const settled = await walletManager.settleWager(room.wager.id, winner.playerId);
            await roomManager.update(room.code, (current) => {
              if (current?.wager?.id === settled.id) {
                current.wager.status = "settled";
                current.wager.winnerPlayerId = winner.playerId;
              }
            });
            const finished = await roomManager.get(room.code);
            if (finished?.game) io.to(winner.socketId).emit("game:state", getPlayerView(finished.game, winner.socketId));
            io.to(winner.socketId).emit("wager:state", publicWager(settled));
            await emitWallet(io, walletManager, winner);
          }
        }
      } catch (error) {
        console.error("[multiplayer] wager disconnect settlement failed", error);
      } finally {
        Promise.resolve(roomManager.disconnect(socket.id)).catch((error) => {
          console.error("[multiplayer] disconnect cleanup failed", error);
        });
      }
    });
  });
}

module.exports = { attachRoomHandlers, publicWager, emitWallet };
