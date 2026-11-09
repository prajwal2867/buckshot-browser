"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const { RoomManager, validateUsername } = require("./room-manager");

function createAppServer({ roomManager = new RoomManager() } = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const publicRoot = path.join(__dirname, "..");

  app.use(express.static(publicRoot, {
    index: "index.html",
    etag: true,
    maxAge: "1h"
  }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "buckshot-multiplayer" }));

  io.on("connection", (socket) => {
    socket.on("room:create", (payload = {}) => {
      const username = payload.username;
      if (!validateUsername(username)) {
        socket.emit("room:error", { message: "Choose a username with 3–16 letters, numbers, underscores or hyphens." });
        return;
      }
      try {
        const room = roomManager.create({ socketId: socket.id, username });
        socket.join(room.code);
        socket.emit("room:created", {
          code: room.code,
          host: room.host,
          status: room.status
        });
      } catch (error) {
        socket.emit("room:error", { message: error.message });
      }
    });

    socket.on("room:join", (payload = {}) => {
      const username = payload.username;
      if (!validateUsername(username)) {
        socket.emit("room:error", { message: "Choose a valid username before joining." });
        return;
      }
      const result = roomManager.requestJoin({
        socketId: socket.id,
        username,
        code: String(payload.code || "").trim()
      });
      if (!result.ok) {
        socket.emit("room:error", { message: result.error });
        return;
      }
      socket.emit("room:join-pending", { code: result.code, hostUsername: result.hostUsername });
      io.to(result.hostSocketId).emit("room:join-request", {
        code: result.code,
        requestId: result.requestId,
        username
      });
    });

    socket.on("room:respond", (payload = {}) => {
      const result = roomManager.respond({
        hostSocketId: socket.id,
        code: String(payload.code || ""),
        requestId: String(payload.requestId || ""),
        accepted: payload.accepted === true
      });
      if (!result.ok) {
        socket.emit("room:error", { message: result.error });
        return;
      }
      const guestSocket = io.sockets.sockets.get(result.guestSocketId);
      if (result.accepted && guestSocket) {
        socket.join(result.code);
        guestSocket.join(result.code);
        socket.emit("room:player-joined", {
          code: result.code,
          host: result.host,
          guest: result.guest
        });
        guestSocket.emit("room:joined", {
          code: result.code,
          host: result.host,
          guest: result.guest
        });
      } else if (!result.accepted && guestSocket) {
        guestSocket.emit("room:declined", { code: payload.code });
      }
    });

    socket.on("disconnect", () => roomManager.disconnect(socket.id));
  });

  return { app, httpServer, io, roomManager };
}

if (require.main === module) {
  const { httpServer } = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Buckshot multiplayer server listening on port ${port}`);
  });
}

module.exports = { createAppServer };
