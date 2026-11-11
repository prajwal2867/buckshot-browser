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
    this.socketRooms = new Map();
  }

  create(host, now = Date.now()) {
    this.expire(now);
    if (this.socketRooms.has(host.socketId)) throw new Error("You are already in a room.");
    let code;
    for (let attempt = 0; attempt < 9000; attempt++) {
      code = this.randomCode();
      if (/^\d{4}$/.test(code) && !this.rooms.has(code)) break;
      code = null;
    }
    if (!code) throw new Error("No room codes are currently available.");

    const room = {
      code, status: "waiting",
      host: { socketId: host.socketId, playerId: host.playerId, username: host.username },
      guest: null, pending: null, game: null, wager: null, wager: null,
      createdAt: now, updatedAt: now
    };
    this.rooms.set(code, room);
    this.socketRooms.set(host.socketId, { code, role: "host" });
    return room;
  }

  requestJoin({ socketId, playerId, username, code }, now = Date.now()) {
    this.expire(now);
    if (!/^\d{4}$/.test(String(code))) return { ok: false, error: "Invalid code." };
    const room = this.rooms.get(String(code));
    if (!room || room.status !== "waiting") return { ok: false, error: "Invalid code." };
    if (room.host.socketId === socketId) return { ok: false, error: "You cannot join your own room." };
    if (this.socketRooms.has(socketId)) return { ok: false, error: "You are already in a room." };
    if (room.pending) return { ok: false, error: "This room already has a pending request." };

    const requestId = crypto.randomUUID();
    room.pending = { requestId, socketId, playerId: arguments[0].playerId, username };
    this.socketRooms.set(socketId, { code: room.code, role: "pending" });
    room.updatedAt = now;
    return { ok: true, requestId, hostSocketId: room.host.socketId, code: room.code, hostUsername: room.host.username };
  }

  respond({ hostSocketId, code, requestId, accepted }, now = Date.now()) {
    const room = this.rooms.get(String(code));
    if (!room || room.host.socketId !== hostSocketId || !room.pending || room.pending.requestId !== requestId) {
      return { ok: false, error: "That join request is no longer available." };
    }
    const pending = room.pending;
    room.pending = null;
    this.socketRooms.delete(pending.socketId);
    room.updatedAt = now;
    if (!accepted) return { ok: true, accepted: false, guestSocketId: pending.socketId };

    room.guest = { socketId: pending.socketId, playerId: pending.playerId, username: pending.username };
    this.socketRooms.set(pending.socketId, { code: room.code, role: "guest" });
    room.status = "lobby";
    return { ok: true, accepted: true, code: room.code, host: room.host, guest: room.guest, guestSocketId: pending.socketId };
  }

  get(code) {
    return this.rooms.get(String(code)) || null;
  }

  getRoomForSocket(socketId) {
    const membership = this.socketRooms.get(socketId);
    return membership ? this.get(membership.code) : null;
  }

  update(code, updater) {
    const room = this.get(code);
    if (!room) return null;
    updater(room);
    room.updatedAt = Date.now();
    return room;
  }

  disconnect(socketId) {
    const membership = this.socketRooms.get(socketId);
    if (!membership) return;
    this.socketRooms.delete(socketId);
    const room = this.rooms.get(membership.code);
    if (!room) return;
    if (membership.role === "host") {
      if (room.guest) this.socketRooms.delete(room.guest.socketId);
      if (room.pending) this.socketRooms.delete(room.pending.socketId);
      this.rooms.delete(membership.code);
      return;
    }
    if (membership.role === "guest" && room.guest?.socketId === socketId) {
      room.guest = null;
      room.status = "waiting";
      room.game = null;
      room.updatedAt = Date.now();
    } else if (membership.role === "pending" && room.pending?.socketId === socketId) {
      room.pending = null;
      room.updatedAt = Date.now();
    }
  }

  expire(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (now - room.updatedAt >= this.ttlMs) {
        this.socketRooms.delete(room.host.socketId);
        if (room.guest) this.socketRooms.delete(room.guest.socketId);
        if (room.pending) this.socketRooms.delete(room.pending.socketId);
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, validateUsername };
