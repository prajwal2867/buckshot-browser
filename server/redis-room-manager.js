"use strict";

const crypto = require("node:crypto");

const CREATE_ROOM = `
  if redis.call("EXISTS", KEYS[2]) == 1 then return -1 end
  local created = redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2], "NX")
  if not created then return 0 end
  redis.call("SET", KEYS[2], "host:" .. ARGV[3], "EX", ARGV[2])
  return 1
`;
const REQUEST_JOIN = `
  local raw = redis.call("GET", KEYS[1])
  if not raw then return {"error", "Invalid code."} end
  local room = cjson.decode(raw)
  if room.status ~= "waiting" then return {"error", "Invalid code."} end
  if room.host.socketId == ARGV[1] then return {"error", "You cannot join your own room."} end
  if redis.call("EXISTS", KEYS[2]) == 1 then return {"error", "You are already in a room."} end
  if room.pending ~= nil and room.pending ~= cjson.null then return {"error", "This room already has a pending request."} end
  room.pending = cjson.decode(ARGV[2])
  room.updatedAt = tonumber(ARGV[3])
  redis.call("SET", KEYS[1], cjson.encode(room), "EX", ARGV[4])
  redis.call("SET", KEYS[2], "pending:" .. room.code, "EX", ARGV[4])
  redis.call("SET", ARGV[5] .. "socket:" .. room.host.socketId, "host:" .. room.code, "EX", ARGV[4])
  return {"ok", room.pending.requestId, room.host.socketId, room.code, room.host.username}
`;
const RESPOND = `
  local raw = redis.call("GET", KEYS[1])
  if not raw then return {"error", "That join request is no longer available."} end
  local room = cjson.decode(raw)
  if room.host.socketId ~= ARGV[1] or room.pending == nil or room.pending == cjson.null or room.pending.requestId ~= ARGV[2] then
    return {"error", "That join request is no longer available."}
  end
  local guest = room.pending
  redis.call("DEL", ARGV[6] .. guest.socketId)
  room.pending = cjson.null
  room.updatedAt = tonumber(ARGV[4])
  if ARGV[3] == "1" then
    room.guest = {socketId = guest.socketId, playerId = guest.playerId, username = guest.username}
    room.status = "lobby"
    redis.call("SET", ARGV[6] .. guest.socketId, "guest:" .. room.code, "EX", ARGV[5])
  end
  redis.call("SET", ARGV[6] .. room.host.socketId, "host:" .. room.code, "EX", ARGV[5])
  redis.call("SET", KEYS[1], cjson.encode(room), "EX", ARGV[5])
  if ARGV[3] == "1" then
    return {"ok", "accepted", room.code, room.host.username, room.host.socketId, room.guest.username, room.guest.socketId}
  end
  return {"ok", "declined", room.code, guest.socketId}
`;
const DISCONNECT = `
  local membership = redis.call("GET", KEYS[1])
  if not membership then return 0 end
  redis.call("DEL", KEYS[1])
  local role, code = string.match(membership, "^(%a+):(%d%d%d%d)$")
  if not role then return 0 end
  local roomKey = ARGV[1] .. code
  local raw = redis.call("GET", roomKey)
  if not raw then return 0 end
  local room = cjson.decode(raw)
  if role == "host" and room.host.socketId == ARGV[2] then
    if room.guest ~= nil and room.guest ~= cjson.null then redis.call("DEL", ARGV[3] .. room.guest.socketId) end
    if room.pending ~= nil and room.pending ~= cjson.null then redis.call("DEL", ARGV[3] .. room.pending.socketId) end
    redis.call("DEL", roomKey)
    return 1
  end
  if role == "guest" and room.guest ~= nil and room.guest ~= cjson.null and room.guest.socketId == ARGV[2] then
    room.guest = cjson.null
    room.status = "waiting"
    room.game = cjson.null
  elseif role == "pending" and room.pending ~= nil and room.pending ~= cjson.null and room.pending.socketId == ARGV[2] then
    room.pending = cjson.null
  else
    return 0
  end
  room.updatedAt = tonumber(ARGV[4])
  redis.call("SET", ARGV[3] .. room.host.socketId, "host:" .. room.code, "EX", ARGV[5])
  redis.call("SET", roomKey, cjson.encode(room), "EX", ARGV[5])
  return 1
`;
const COMPARE_AND_SET = `
  local current = redis.call("GET", KEYS[1])
  if not current or current ~= ARGV[1] then return 0 end
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
`;

class RedisRoomManager {
  constructor(redis, { ttlSeconds = 300, keyPrefix = "buckshot:rooms:", randomCode = null } = {}) {
    if (!redis || typeof redis.eval !== "function") throw new TypeError("A connected Redis client is required.");
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.keyPrefix = keyPrefix;
    this.randomCode = randomCode || (() => String(1000 + crypto.randomInt(0, 9000)));
  }
  roomKey(code) { return `${this.keyPrefix}room:${code}`; }
  socketKey(socketId) { return `${this.keyPrefix}socket:${socketId}`; }

  async create(host, now = Date.now()) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const code = this.randomCode();
      if (!/^\d{4}$/.test(code)) continue;
      const room = { code, status: "waiting", host: { socketId: host.socketId, playerId: host.playerId, username: host.username },
        guest: null, pending: null, game: null, wager: null, createdAt: now, updatedAt: now };
      const result = await this.redis.eval(CREATE_ROOM, 2, this.roomKey(code), this.socketKey(host.socketId),
        JSON.stringify(room), this.ttlSeconds, code);
      if (result === 1) return room;
      if (result === -1) throw new Error("You are already in a room.");
    }
    throw new Error("No room codes are currently available. Try again.");
  }

  async requestJoin({ socketId, playerId, username, code }, now = Date.now()) {
    if (!/^\d{4}$/.test(String(code))) return { ok: false, error: "Invalid code." };
    const response = await this.redis.eval(REQUEST_JOIN, 2, this.roomKey(String(code)), this.socketKey(socketId),
      socketId, JSON.stringify({ requestId: crypto.randomUUID(), socketId, playerId, username }), now, this.ttlSeconds, this.keyPrefix);
    if (response[0] !== "ok") return { ok: false, error: response[1] };
    return { ok: true, requestId: response[1], hostSocketId: response[2], code: response[3], hostUsername: response[4] };
  }

  async respond({ hostSocketId, code, requestId, accepted }, now = Date.now()) {
    const response = await this.redis.eval(RESPOND, 1, this.roomKey(String(code)), hostSocketId, requestId,
      accepted ? "1" : "0", now, this.ttlSeconds, this.keyPrefix + "socket:");
    if (response[0] !== "ok") return { ok: false, error: response[1] };
    if (response[1] === "declined") return { ok: true, accepted: false, code: response[2], guestSocketId: response[3] };
    return { ok: true, accepted: true, code: response[2],
      host: { username: response[3], socketId: response[4] },
      guest: { username: response[5], socketId: response[6] }, guestSocketId: response[6] };
  }

  async get(code) {
    const raw = await this.redis.get(this.roomKey(String(code)));
    return raw ? JSON.parse(raw) : null;
  }

  async getRoomForSocket(socketId) {
    const membership = await this.redis.get(this.socketKey(socketId));
    if (!membership) return null;
    const match = /^(?:host|guest|pending):(\\d{4})$/.exec(membership);
    return match ? this.get(match[1]) : null;
  }

  async update(code, updater) {
    const key = this.roomKey(String(code));
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const room = JSON.parse(raw);
      updater(room);
      room.updatedAt = Date.now();
      const next = JSON.stringify(room);
      const saved = await this.redis.eval(COMPARE_AND_SET, 1, key, raw, next, this.ttlSeconds);
      if (saved === 1) return room;
    }
    throw new Error("The room is busy. Please retry your action.");
  }

  async disconnect(socketId, now = Date.now()) {
    return this.redis.eval(DISCONNECT, 1, this.socketKey(socketId), this.keyPrefix + "room:",
      socketId, this.keyPrefix + "socket:", now, this.ttlSeconds);
  }
  async expire() { return 0; }
}

module.exports = { RedisRoomManager };
