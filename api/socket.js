"use strict";

const http = require("node:http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { RedisRoomManager } = require("../server/redis-room-manager");
const { attachRoomHandlers } = require("../server/room-handlers");
const { attachGameHandlers } = require("../server/game-handlers");
const { RedisWalletManager } = require("../server/wallet-manager");

const httpServer = http.createServer();
const io = new Server(httpServer, {
  path: "/api/socket",
  addTrailingSlash: false,
  transports: ["websocket"],
  serveClient: false
});

httpServer.on("request", (_request, response) => {
  if (!response.headersSent && !response.writableEnded) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }
});

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  io.on("connection", (socket) => {
    socket.emit("room:error", {
      message: "Online multiplayer is not configured yet. Add REDIS_URL to the Vercel project and redeploy."
    });
    socket.disconnect(true);
  });
} else {
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5000)
  };
  const publisher = new Redis(redisUrl, redisOptions);
  const subscriber = publisher.duplicate();
  const stateClient = publisher.duplicate();
  io.adapter(createAdapter(publisher, subscriber));
  const roomManager = new RedisRoomManager(stateClient);
  const walletManager = new RedisWalletManager(stateClient);
  attachRoomHandlers(io, roomManager, walletManager);
  attachGameHandlers(io, roomManager, walletManager);
}

module.exports = httpServer;
