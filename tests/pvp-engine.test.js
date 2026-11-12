"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGame, performAction, getPlayerView } = require("../server/pvp-engine");

function gameWithTurn(random = () => 0.1) {
  const state = createGame({ id: "a", username: "Alice" }, { id: "b", username: "Bob" }, random);
  state.turnPlayerId = "a";
  state.chamber = ["blank", "live", "blank"];
  state.liveRemaining = 1;
  state.blankRemaining = 2;
  return state;
}

test("match starts with two players at four health and a randomized first player", () => {
  const state = createGame({ id: "a", username: "Alice" }, { id: "b", username: "Bob" }, () => 0.9);
  assert.equal(state.players[0].health, 4);
  assert.equal(state.players[1].health, 4);
  assert.equal(state.turnPlayerId, "b");
  assert.ok(state.chamber.length >= 2 && state.chamber.length <= 8);
  assert.ok(state.liveRemaining > 0 && state.blankRemaining > 0);
});

test("a live shot damages its target and passes the turn", () => {
  const state = gameWithTurn();
  state.chamber = ["live", "blank"];
  state.liveRemaining = 1;
  state.blankRemaining = 1;
  assert.deepEqual(performAction(state, "a", { type: "shoot", target: "opponent" }), { ok: true });
  assert.equal(state.players[1].health, 3);
  assert.equal(state.turnPlayerId, "b");
});

test("a blank self-shot keeps the turn; a blank opponent shot passes it", () => {
  const state = gameWithTurn();
  performAction(state, "a", { type: "shoot", target: "self" });
  assert.equal(state.turnPlayerId, "a");
  state.chamber = ["blank"];
  state.liveRemaining = 0;
  state.blankRemaining = 1;
  performAction(state, "a", { type: "shoot", target: "opponent" });
  assert.equal(state.turnPlayerId, "b");
});

test("zero health ends the match immediately", () => {
  const state = gameWithTurn();
  state.chamber = ["live"];
  state.liveRemaining = 1;
  state.blankRemaining = 0;
  state.players[1].health = 1;
  performAction(state, "a", { type: "shoot", target: "opponent" });
  assert.equal(state.status, "finished");
  assert.equal(state.winnerId, "a");
});

test("the server rejects actions from the wrong player", () => {
  const state = gameWithTurn();
  assert.equal(performAction(state, "b", { type: "shoot", target: "self" }).ok, false);
  assert.equal(state.chamber.length, 3);
});

test("magnifying glass knowledge is private to the player who used it", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Magnifying Glass"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(getPlayerView(state, "a").knownCurrentShell, "blank");
  assert.equal(getPlayerView(state, "b").knownCurrentShell, null);
  assert.equal(getPlayerView(state, "b").events.some((event) => event.includes("checks the current shell")), false);
});

test("handcuffs skip the opponent's next turn after a turn-changing shot", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Handcuffs"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(state.players[1].handcuffed, true);
  state.chamber = ["live", "blank"];
  state.liveRemaining = 1;
  state.blankRemaining = 1;
  performAction(state, "a", { type: "shoot", target: "opponent" });
  assert.equal(state.turnPlayerId, "a");
  assert.equal(state.players[1].handcuffed, false);
});

test("Adrenaline steals and uses a valid opponent item", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Adrenaline"];
  state.players[1].inventory = ["Hand Saw"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.deepEqual(getPlayerView(state, "a").stealOptions, ["Hand Saw"]);
  performAction(state, "a", { type: "steal", itemIndex: 0 });
  assert.equal(state.players[0].inventory.length, 0);
  assert.equal(state.players[1].inventory.length, 0);
  assert.equal(state.sawedOff, true);
});

test("opening the inventory records Story Mode-style numbered menu events privately", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Beer", "Hand Saw", "Magnifying Glass", "Beer"];
  assert.deepEqual(performAction(state, "a", { type: "item:menu" }), { ok: true });
  const ownEvents = getPlayerView(state, "a").events;
  const opponentEvents = getPlayerView(state, "b").events;
  assert.ok(ownEvents.includes("Choose an item number (0 to return). Item effects:"));
  assert.ok(ownEvents.includes("1. Magnifying Glass"));
  assert.ok(ownEvents.includes("2. Beer"));
  assert.ok(ownEvents.includes("3. Hand Saw"));
  assert.equal(ownEvents.filter((event) => event === "2. Beer").length, 1);
  assert.equal(opponentEvents.some((event) => event.includes("Choose an item number")), false);
  assert.equal(opponentEvents.some((event) => event.includes("Magnifying Glass")), false);
  assert.equal(state.turnPlayerId, "a");
});

test("empty inventory and invalid item-menu selections are recorded privately", () => {
  const state = gameWithTurn();
  state.players[0].inventory = [];
  performAction(state, "a", { type: "item:menu" });
  assert.ok(getPlayerView(state, "a").events.includes("Your inventory is empty."));
  assert.equal(getPlayerView(state, "b").events.includes("Your inventory is empty."), false);
  state.players[0].inventory = ["Hand Saw"];
  performAction(state, "a", { type: "item:invalid" });
  assert.ok(getPlayerView(state, "a").events.includes("Choose a listed item, or 0 to return."));
  assert.equal(getPlayerView(state, "b").events.includes("Choose a listed item, or 0 to return."), false);
});

test("inventory item use does not consume the player's turn", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Hand Saw"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(state.turnPlayerId, "a");
  assert.equal(state.sawedOff, true);
});

test("player snapshots never expose the chamber sequence or opponent's private knowledge", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Magnifying Glass"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  const view = getPlayerView(state, "b");
  assert.equal("chamber" in view, false);
  assert.equal("knownShell" in view, false);
  assert.equal(view.knownCurrentShell, null);
});


test("Beer ejects the current shell without passing the turn", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Beer"];
  state.chamber = ["blank", "live"];
  state.liveRemaining = 1;
  state.blankRemaining = 1;
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.deepEqual(state.chamber, ["live"]);
  assert.equal(state.turnPlayerId, "a");
});

test("Inverter flips the current shell and updates shell counts", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Inverter"];
  state.chamber = ["blank", "live"];
  state.liveRemaining = 1;
  state.blankRemaining = 1;
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(state.chamber[0], "live");
  assert.equal(state.liveRemaining, 2);
  assert.equal(state.blankRemaining, 0);
  assert.equal(getPlayerView(state, "a").knownCurrentShell, "live");
});

test("Cigarette Pack heals one point but never exceeds maximum health", () => {
  const state = gameWithTurn();
  state.players[0].health = 2;
  state.players[0].inventory = ["Cigarette Pack"];
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(state.players[0].health, 3);
});

test("Burner Phone reveals a future shell only to its user", () => {
  const state = gameWithTurn();
  state.players[0].inventory = ["Burner Phone"];
  state.chamber = ["blank", "live", "blank"];
  state.liveRemaining = 1;
  state.blankRemaining = 2;
  performAction(state, "a", { type: "item", itemIndex: 0 });
  assert.equal(getPlayerView(state, "a").events.some((event) => event.includes("future shell")), true);
  assert.equal(getPlayerView(state, "b").events.some((event) => event.includes("future shell")), false);
  assert.equal(getPlayerView(state, "b").knownCurrentShell, null);
  assert.deepEqual(state.futureKnowledge.a, { 1: "live" });
});
