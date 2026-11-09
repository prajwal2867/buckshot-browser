"use strict";

const http = require("node:http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { RedisRoomManager } = require("../server/redis-room-manager");
const { attachRoomHandlers } = require("../server/room-handlers");

const httpServer = http.createServer((_request, response) => {
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
});

const io = new Server(httpServer, {
  path: "/api/socket",
  transports: ["websocket"],
  serveClient: false
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
  attachRoomHandlers(io, new RedisRoomManager(stateClient));
}

module.exports = httpServer;