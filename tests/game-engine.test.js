"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require("node:path").join(__dirname, "..", "game.js"), "utf8");

function boot(randomValues = []) {
  const values = [...randomValues];
  const math = Object.create(Math);
  math.random = () => values.length ? values.shift() : 0.5;
  const screen = { innerHTML: "", scrollTop: 0, scrollHeight: 0 };
  const input = { value: "", readOnly: false, disabled: false, focus() {}, blur() {} };
  const form = { addEventListener() {}, requestSubmit() {} };
  const keypad = { querySelectorAll: () => [], addEventListener() {} };
  const label = { textContent: "" };
  const nodes = {
    "#screen": screen,
    "#command-form": form,
    "#command-input": input,
    "#prompt-label": label,
    "#keypad": keypad
  };
  const document = { querySelector: (selector) => nodes[selector] };
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 1,
    clearTimeout() {},
    location: { reload() {} }
  };
  vm.runInNewContext(source, { document, window, Math: math, Date, clearTimeout() {} });
  return window.buckshotGame;
}

test("Story stage 1 loads its fixed 3-shell and 5-shell magazines", () => {
  const game = boot();
  game.start("story");
  assert.equal(game.chamber.length, 3);
  assert.equal(game.liveRemaining, 1);
  assert.equal(game.blankRemaining, 2);
  game.reload();
  assert.equal(game.chamber.length, 5);
  assert.equal(game.liveRemaining, 3);
  assert.equal(game.blankRemaining, 2);
});

test("Double or Nothing gives both sides the same health", () => {
  const game = boot([0.01, 0.99, 0.5, 0.5, 0.5, 0.5, 0.5]);
  game.start("double");
  assert.equal(game.player.health, game.dealer.health);
  assert.ok(game.player.health >= 2 && game.player.health <= 4);
});

test("random magazine loads always contain both shell types and differ by at most one", () => {
  for (const value of [0.01, 0.2, 0.49, 0.5, 0.8, 0.99]) {
    const game = boot(Array(80).fill(value));
    game.start("double");
    const total = game.chamber.length;
    assert.ok(total >= 2 && total <= 8);
    assert.ok(game.liveRemaining >= 1 && game.blankRemaining >= 1);
    assert.ok(Math.abs(game.liveRemaining - game.blankRemaining) <= 1);
  }
});

test("inventory carries over between reloads and never exceeds eight slots", () => {
  const game = boot();
  game.start("story");
  game.stage = 2;
  game.beginStage();
  game.player.inventory = ["Cigarette Pack", "Beer", "Hand Saw", "Handcuffs", "Magnifying Glass", "Beer", "Beer"];
  game.reload();
  assert.equal(game.player.inventory.length, 8);
  assert.equal(game.player.inventory[0], "Cigarette Pack");
  game.reload();
  assert.equal(game.player.inventory.length, 8);
});

test("Beer ejecting a shell cancels a prepared Hand Saw", () => {
  const game = boot();
  game.start("story");
  game.chamber = ["blank", "live"];
  game.liveRemaining = 1;
  game.blankRemaining = 1;
  game.isSawedOff = true;
  assert.equal(game.useItem(game.player, "Beer"), true);
  assert.equal(game.isSawedOff, false);
});

test("Burner Phone knowledge shifts forward as shells are consumed", () => {
  const game = boot();
  game.start("double");
  game.chamber = ["live", "blank", "live"];
  game.liveRemaining = 2;
  game.blankRemaining = 1;
  game.futureKnowledge.player = { 1: "blank" };
  game.drawShell();
  assert.equal(game.futureKnowledge.player[0], "blank");
  assert.equal(game.currentKnowledge(game.player), "blank");
});

test("Story stage 3 cuts the wire at zero normal charges and the next hit is fatal", () => {
  const game = boot();
  game.start("story");
  game.stage = 3;
  game.player.health = 1;
  game.player.fadedHealth = 2;
  game.damage(game.player, 1);
  assert.equal(game.player.health, 0);
  assert.equal(game.player.cutWire, true);
  assert.equal(game.player.dead, false);
  game.damage(game.player, 1);
  assert.equal(game.player.dead, true);
});

test("Double or Nothing calculates the timed payout once, then doubles it", () => {
  const game = boot();
  game.start("double");
  game.stage = 3;
  game.setNumber = 1;
  game.setStartedAt = Date.now() - 60000;
  game.dealer.dead = true;
  game.checkStageEnd();
  assert.equal(game.winnings, 66000);
  game.setNumber = 2;
  game.dealer.dead = true;
  game.player.dead = false;
  game.checkStageEnd();
  assert.equal(game.winnings, 132000);
});

test("Dealer stops its item phase when Adrenaline steals a Beer that reloads the shotgun", () => {
  const game = boot();
  game.start("double");
  game.current = game.dealer;
  game.opponent = game.player;
  game.dealer.inventory = ["Adrenaline"];
  game.player.inventory = ["Beer"];
  game.chamber = ["blank"];
  game.liveRemaining = 0;
  game.blankRemaining = 1;
  game.dealerUseItems();
  assert.equal(game.current, game.player);
  assert.equal(game.dealer.inventory.includes("Adrenaline"), false);
  assert.ok(game.dealer.inventory.length <= 8);
  assert.ok(game.chamber.length >= 2);
});

test("zero health ends a Double or Nothing run even in stages 1 and 2", () => {
  const game = boot();
  game.start("double");
  game.stage = 1;
  game.player.health = 0;
  assert.equal(game.checkStageEnd(), true);
  assert.equal(game.gameOver, true);
  assert.equal(game.winnings, 0);
});

test("Story losses in stages 1 and 2 revive the player and apply the correct penalties", () => {
  const game = boot();
  game.start("story");
  game.player.health = 0;
  game.checkStageEnd();
  assert.equal(game.stage, 2);
  assert.equal(game.storyPenalty, 4000);
  assert.equal(game.player.health, 4);
  game.player.health = 0;
  game.checkStageEnd();
  assert.equal(game.stage, 3);
  assert.equal(game.storyPenalty, 6000);
  assert.equal(game.player.health, 4);
  assert.equal(game.player.fadedHealth, 2);
});

test("Story Mode payout deducts deaths, cigarettes and beer", () => {
  const game = boot();
  game.start("story");
  game.storyPenalty = 6000;
  game.cigarettesUsed = 2;
  game.beersUsed = 1;
  assert.equal(game.storyCash(), 63065);
});
