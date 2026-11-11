"use strict";

const { createGame, performAction, getPlayerView } = require("./pvp-engine");
const { emitWallet, publicWager } = require("./room-handlers");

async function emitGameState(io, room) {
  if (!room?.game) return;
  for (const player of room.game.players) {
    io.to(player.id).emit("game:state", getPlayerView(room.game, player.id));
  }
}
async function emitWagerState(io, room, walletManager) {
  if (!room) return;
  io.to(room.code).emit("wager:state", publicWager(room.wager));
  await Promise.all([
    emitWallet(io, walletManager, room.host),
    emitWallet(io, walletManager, room.guest)
  ]);
}
function attachGameHandlers(io, roomManager, walletManager) {
  io.on("connection", (socket) => {
    socket.on("game:start", async (payload = {}) => {
      const code = String(payload.code || "").trim();
      try {
        let started = false;
        await roomManager.update(code, (room) => {
          if (!room || room.status !== "lobby" || !room.host ||
              room.host.socketId !== socket.id || !room.guest ||
              room.wager?.status !== "locked") return;
          room.game = createGame(
            { id: room.host.socketId, username: room.host.username },
            { id: room.guest.socketId, username: room.guest.username }
          );
          room.status = "playing";
          started = true;
        });
        if (!started) {
          socket.emit("room:error", { message: "Both players must accept and lock the same wager before the host can start the match." });
          return;
        }
        const room = await roomManager.get(code);
        await emitGameState(io, room);
        io.to(code).emit("game:started", { code });
      } catch {
        socket.emit("room:error", { message: "Could not start the match. Please try again." });
      }
    });

    socket.on("game:action", async (payload = {}) => {
      const code = String(payload.code || "").trim();
      try {
        let outcome = { ok: false, error: "Match not found." };
        await roomManager.update(code, (room) => {
          if (!room?.game || room.status !== "playing") return;
          outcome = performAction(room.game, socket.id, payload.action);
        });
        if (!outcome.ok) {
          socket.emit("game:error", { message: outcome.error });
          return;
        }
        let room = await roomManager.get(code);
        if (room?.game?.status === "finished" && room.wager?.status === "locked") {
          const winner = room.host.socketId === room.game.winnerId ? room.host : room.guest;
          const settled = await walletManager.settleWager(room.wager.id, winner.playerId);
          await roomManager.update(code, (current) => {
            if (current?.wager?.id === settled.id) {
              current.wager.status = "settled";
              current.wager.winnerPlayerId = winner.playerId;
              current.wager.settledAt = settled.settledAt || Date.now();
            }
          });
          room = await roomManager.get(code);
          await emitWagerState(io, room, walletManager);
        }
        await emitGameState(io, room);
      } catch (error) {
        console.error("[multiplayer] game action failed", error);
        socket.emit("game:error", { message: "The match service is temporarily unavailable. Please wait for the server to confirm the result." });
      }
    });
  });
}

module.exports = { attachGameHandlers, emitGameState };
