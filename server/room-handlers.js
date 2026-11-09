"use strict";

const { validateUsername } = require("./room-manager");

function attachRoomHandlers(io, roomManager) {
  io.on("connection", (socket) => {
    socket.on("room:create", async (payload = {}) => {
      const username = payload.username;
      if (!validateUsername(username)) {
        socket.emit("room:error", { message: "Choose a username with 3–16 letters, numbers, underscores or hyphens." });
        return;
      }

      try {
        const room = await roomManager.create({ socketId: socket.id, username });
        await socket.join(room.code);
        socket.emit("room:created", {
          code: room.code,
          host: room.host,
          status: room.status
        });
      } catch (error) {
        socket.emit("room:error", { message: error.message || "Could not create a room." });
      }
    });

    socket.on("room:join", async (payload = {}) => {
      const username = payload.username;
      if (!validateUsername(username)) {
        socket.emit("room:error", { message: "Choose a valid username before joining." });
        return;
      }

      try {
        const result = await roomManager.requestJoin({
          socketId: socket.id,
          username,
          code: String(payload.code || "").trim()
        });
        if (!result.ok) {
          socket.emit("room:error", { message: result.error });
          return;
        }

        socket.emit("room:join-pending", {
          code: result.code,
          hostUsername: result.hostUsername
        });
        io.to(result.hostSocketId).emit("room:join-request", {
          code: result.code,
          requestId: result.requestId,
          username
        });
      } catch (error) {
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
        if (!result.ok) {
          socket.emit("room:error", { message: result.error });
          return;
        }

        if (result.accepted) {
          const guestSockets = await io.in(result.guestSocketId).fetchSockets();
          if (!guestSockets.length) {
            await roomManager.disconnect(result.guestSocketId);
            socket.emit("room:error", { message: "That player disconnected before you could approve the request." });
            return;
          }
          await socket.join(result.code);
          // The guest may be connected to another Vercel Function instance.
          // The Redis adapter makes this remote socket operation cross-instance.
          await io.in(result.guestSocketId).socketsJoin(result.code);
          io.to(socket.id).emit("room:player-joined", {
            code: result.code,
            host: result.host,
            guest: result.guest
          });
          io.to(result.guestSocketId).emit("room:joined", {
            code: result.code,
            host: result.host,
            guest: result.guest
          });
        } else {
          io.to(result.guestSocketId).emit("room:declined", { code: String(payload.code || "") });
        }
      } catch (error) {
        socket.emit("room:error", { message: "Could not process that join request." });
      }
    });

    socket.on("disconnect", () => {
      Promise.resolve(roomManager.disconnect(socket.id)).catch((error) => {
        console.error("[multiplayer] disconnect cleanup failed", error);
      });
    });
  });
}

module.exports = { attachRoomHandlers };