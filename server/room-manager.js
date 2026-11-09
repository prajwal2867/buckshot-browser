"use strict";

const crypto = require("node:crypto");

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,16}$/;

function validateUsername(value) {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}

class RoomManager {
  constructor({ ttlMs = 5 * 60 * 1000, randomCode = null } = {}) {
    this.ttlMs = ttlMs;
    this.randomCode = randomCode || (() => String(1000 + crypto.randomInt(0, 9000)));
    this.rooms = new Map();
  }

  create(host, now = Date.now()) {
    this.expire(now);
    let code;
    for (let attempt = 0; attempt < 9000; attempt++) {
      code = this.randomCode();
      if (/^\d{4}$/.test(code) && !this.rooms.has(code)) break;
      code = null;
    }
    if (!code) throw new Error("No room codes are currently available.");

    const room = {
      code,
      status: "waiting",
      host: { socketId: host.socketId, username: host.username },
      guest: null,
      pending: null,
      createdAt: now,
      updatedAt: now
    };
    this.rooms.set(code, room);
    return room;
  }

  requestJoin({ socketId, username, code }, now = Date.now()) {
    this.expire(now);
    if (!/^\d{4}$/.test(String(code))) return { ok: false, error: "Invalid code." };
    const room = this.rooms.get(String(code));
    if (!room || room.status !== "waiting") return { ok: false, error: "Invalid code." };
    if (room.host.socketId === socketId) return { ok: false, error: "You cannot join your own room." };
    if (room.pending) return { ok: false, error: "This room already has a pending request." };

    const requestId = crypto.randomUUID();
    room.pending = { requestId, socketId, username };
    room.updatedAt = now;
    return {
      ok: true,
      requestId,
      hostSocketId: room.host.socketId,
      code: room.code,
      hostUsername: room.host.username
    };
  }

  respond({ hostSocketId, code, requestId, accepted }, now = Date.now()) {
    const room = this.rooms.get(String(code));
    if (!room || room.host.socketId !== hostSocketId || !room.pending ||
        room.pending.requestId !== requestId) {
      return { ok: false, error: "That join request is no longer available." };
    }

    const pending = room.pending;
    room.pending = null;
    room.updatedAt = now;

    if (!accepted) return { ok: true, accepted: false, guestSocketId: pending.socketId };

    room.guest = { socketId: pending.socketId, username: pending.username };
    room.status = "lobby";
    return {
      ok: true,
      accepted: true,
      code: room.code,
      host: room.host,
      guest: room.guest,
      guestSocketId: pending.socketId
    };
  }

  get(code) {
    return this.rooms.get(String(code)) || null;
  }

  disconnect(socketId) {
    for (const [code, room] of this.rooms) {
      if (room.pending?.socketId === socketId) {
        room.pending = null;
        room.updatedAt = Date.now();
      }
      if (room.host.socketId === socketId) {
        this.rooms.delete(code);
        continue;
      }
      if (room.guest?.socketId === socketId) {
        room.guest = null;
        room.status = "waiting";
        room.updatedAt = Date.now();
      }
    }
  }

  expire(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (now - room.updatedAt >= this.ttlMs) this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager, validateUsername };
