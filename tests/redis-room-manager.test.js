"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Redis = require("ioredis");
const { RedisRoomManager } = require("../server/redis-room-manager");

const redisUrl = process.env.REDIS_URL;
const integrationTest = (name, fn) => test(name, { skip: !redisUrl && "REDIS_URL is not configured" }, fn);

integrationTest("Redis room manager creates rooms and prevents one socket hosting twice", async () => {
  const redis = new Redis(redisUrl);
  const manager = new RedisRoomManager(redis, { keyPrefix: `test:${Date.now()}:`, randomCode: () => "4827" });
  try {
    const room = await manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
    assert.equal(room.code, "4827");
    await assert.rejects(
      () => manager.create({ socketId: "host-1", username: "HostPlayer" }, 101),
      /already in a room/
    );
    assert.equal((await manager.get("4827")).host.username, "HostPlayer");
  } finally {
    await redis.quit();
  }
});

integrationTest("Redis room manager handles join approval and cross-client membership", async () => {
  const redis = new Redis(redisUrl);
  const manager = new RedisRoomManager(redis, { keyPrefix: `test:${Date.now()}:`, randomCode: () => "7391" });
  try {
    await manager.create({ socketId: "host-2", username: "HostPlayer" }, 100);
    const request = await manager.requestJoin({
      socketId: "guest-2", username: "GuestPlayer", code: "7391"
    }, 101);
    assert.equal(request.ok, true);
    assert.equal(request.hostSocketId, "host-2");
    assert.equal((await manager.getRoomForSocket("host-2")).code, "7391");
    assert.equal((await manager.getRoomForSocket("guest-2")).code, "7391");

    const approved = await manager.respond({
      hostSocketId: "host-2",
      code: "7391",
      requestId: request.requestId,
      accepted: true
    }, 102);
    assert.equal(approved.accepted, true);
    assert.equal(approved.guestSocketId, "guest-2");
    assert.equal((await manager.get("7391")).status, "lobby");
    assert.equal((await manager.getRoomForSocket("guest-2")).guest.username, "GuestPlayer");

    await manager.disconnect("guest-2", 103);
    assert.equal(await manager.getRoomForSocket("guest-2"), null);
    const room = await manager.get("7391");
    assert.equal(room.status, "waiting");
    assert.equal(room.guest, null);
  } finally {
    await redis.quit();
  }
});

integrationTest("Redis room manager rejects unauthorized approvals and removes rooms when host disconnects", async () => {
  const redis = new Redis(redisUrl);
  const manager = new RedisRoomManager(redis, { keyPrefix: `test:${Date.now()}:`, randomCode: () => "8264" });
  try {
    await manager.create({ socketId: "host-3", username: "HostPlayer" }, 100);
    const request = await manager.requestJoin({
      socketId: "guest-3", username: "GuestPlayer", code: "8264"
    }, 101);
    const denied = await manager.respond({
      hostSocketId: "intruder",
      code: "8264",
      requestId: request.requestId,
      accepted: true
    }, 102);
    assert.equal(denied.ok, false);
    assert.equal((await manager.get("8264")).guest, null);

    await manager.disconnect("host-3", 103);
    assert.equal(await manager.get("8264"), null);
  } finally {
    await redis.quit();
  }
});