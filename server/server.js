"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");
const { RoomManager } = require("./room-manager");
const { attachRoomHandlers } = require("./room-handlers");

function createAppServer({ roomManager = new RoomManager() } = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { path: "/api/socket" });
  const expiryTimer = setInterval(() => roomManager.expire(), 60 * 1000);
  expiryTimer.unref?.();
  const publicRoot = path.join(__dirname, "..");

  app.use(express.static(publicRoot, {
    index: "index.html",
    etag: true,
    maxAge: "1h"
  }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "buckshot-multiplayer-local" }));

  attachRoomHandlers(io, roomManager);

  return { app, httpServer, io, roomManager, expiryTimer };
}

if (require.main === module) {
  const { httpServer } = createAppServer();
  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Buckshot multiplayer server listening on port ${port}`);
  });
}

module.exports = { createAppServer };