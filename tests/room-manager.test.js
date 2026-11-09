"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RoomManager, validateUsername } = require("../server/room-manager");

test("username validation accepts safe 3–16 character names", () => {
  assert.equal(validateUsername("NightWolf_7"), true);
  assert.equal(validateUsername("ab"), false);
  assert.equal(validateUsername("name with spaces"), false);
  assert.equal(validateUsername("<script>"), false);
});

test("creates a unique four-digit room and records its host", () => {
  const codes = ["4827", "9134"];
  const manager = new RoomManager({ randomCode: () => codes.shift() });
  const room = manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  assert.equal(room.code, "4827");
  assert.equal(room.status, "waiting");
  assert.equal(room.host.username, "HostPlayer");
  assert.equal(manager.create({ socketId: "host-2", username: "OtherHost" }, 101).code, "9134");
});

test("join requests require a valid active code and host approval", () => {
  const manager = new RoomManager({ randomCode: () => "4827" });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  assert.equal(manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "0000"
  }, 101).error, "Invalid code.");

  const request = manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "4827"
  }, 102);
  assert.equal(request.ok, true);
  assert.equal(manager.get("4827").guest, null);

  const result = manager.respond({
    hostSocketId: "host-1",
    code: "4827",
    requestId: request.requestId,
    accepted: true
  }, 103);
  assert.equal(result.accepted, true);
  assert.equal(manager.get("4827").status, "lobby");
  assert.equal(manager.get("4827").guest.username, "GuestPlayer");
});

test("only the room host can approve a request", () => {
  const manager = new RoomManager({ randomCode: () => "4827" });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  const request = manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "4827"
  }, 101);
  const result = manager.respond({
    hostSocketId: "intruder", code: "4827", requestId: request.requestId, accepted: true
  }, 102);
  assert.equal(result.ok, false);
  assert.equal(manager.get("4827").guest, null);
});

test("declined requests do not occupy the room", () => {
  const manager = new RoomManager({ randomCode: () => "4827" });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  const request = manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "4827"
  }, 101);
  const result = manager.respond({
    hostSocketId: "host-1", code: "4827", requestId: request.requestId, accepted: false
  }, 102);
  assert.equal(result.accepted, false);
  assert.equal(manager.get("4827").status, "waiting");
  assert.equal(manager.get("4827").pending, null);
});

test("rooms expire after their inactivity lifetime", () => {
  const manager = new RoomManager({ ttlMs: 1000, randomCode: () => "4827" });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  manager.expire(1099);
  assert.ok(manager.get("4827"));
  manager.expire(1100);
  assert.equal(manager.get("4827"), null);
});

test("disconnecting the host removes its room", () => {
  const manager = new RoomManager({ randomCode: () => "4827" });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  manager.disconnect("host-1");
  assert.equal(manager.get("4827"), null);
});

test("a socket cannot create or request to join multiple rooms", () => {
  const codes = ["4827", "9134"];
  const manager = new RoomManager({ randomCode: () => codes.shift() });
  manager.create({ socketId: "host-1", username: "HostPlayer" }, 100);
  manager.create({ socketId: "host-2", username: "OtherHost" }, 101);

  assert.throws(
    () => manager.create({ socketId: "host-1", username: "HostPlayer" }, 102),
    /already in a room/
  );

  const request = manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "4827"
  }, 103);
  assert.equal(request.ok, true);
  assert.equal(manager.requestJoin({
    socketId: "guest-1", username: "GuestPlayer", code: "9134"
  }, 104).error, "You are already in a room.");
});


test("room updates persist match state through the room manager", () => {
  const manager = new RoomManager({ randomCode: () => "1234" });
  const room = manager.create({ socketId: "host", username: "Alice" });
  const updated = manager.update(room.code, (current) => {
    current.status = "playing";
    current.game = { status: "playing", turnPlayerId: "host" };
  });
  assert.equal(updated.status, "playing");
  assert.deepEqual(manager.get(room.code).game, { status: "playing", turnPlayerId: "host" });
});
