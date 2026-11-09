"use strict";

const { createGame, performAction, getPlayerView } = require("./pvp-engine");

async function emitGameState(io, room) {
  if (!room?.game) return;
  for (const player of room.game.players) {
    io.to(player.id).emit("game:state", getPlayerView(room.game, player.id));
  }
}
function attachGameHandlers(io, roomManager) {
  io.on("connection", (socket) => {
    socket.on("game:start", async (payload = {}) => {
      const code = String(payload.code || "").trim();
      try {
        let started = false;
        await roomManager.update(code, (room) => {
          if (!room || room.status !== "lobby" || !room.host || room.host.socketId !== socket.id || !room.guest) return;
          room.game = createGame(
            { id: room.host.socketId, username: room.host.username },
            { id: room.guest.socketId, username: room.guest.username }
          );
          room.status = "playing";
          started = true;
        });
        if (!started) {
          socket.emit("room:error", { message: "Only the host can start a ready lobby." });
          return;
        }
        const room = await roomManager.get(code);
        await emitGameState(io, room);
        io.to(code).emit("game:started", { code });
      } catch (error) {
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
        const room = await roomManager.get(code);
        await emitGameState(io, room);
      } catch (error) {
        socket.emit("game:error", { message: "The match service is temporarily unavailable." });
      }
    });
  });
}

module.exports = { attachGameHandlers, emitGameState };
