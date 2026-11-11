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
  const eventLog = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  const screen = {
    innerHTML: "", scrollTop: 0, scrollHeight: 0,
    querySelector: (selector) => selector === ".event-log" ? eventLog : null
  };
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
  const document = { querySelector: (selector) => nodes[selector], getElementById: () => null, addEventListener() {} };
  const scheduledTimers = [];
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (callback, delay) => {
      scheduledTimers.push({ callback, delay });
      return scheduledTimers.length;
    },
    setInterval: (callback, delay) => {
      scheduledTimers.push({ callback, delay, interval: true });
      return scheduledTimers.length;
    },
    clearInterval() {},
    clearTimeout() {},
    location: { reload() {} }
  };
  vm.runInNewContext(source, { document, window, Math: math, Date, clearTimeout() {} });
  window.buckshotGame.scheduledTimers = scheduledTimers;
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
  game.start("story");
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


test("Dealer saves Adrenaline rather than stealing Beer when it would hand over initiative", () => {
  const game = boot();
  game.start("story");
  game.current = game.dealer;
  game.opponent = game.player;
  game.dealer.inventory = ["Adrenaline"];
  game.player.inventory = ["Beer"];
  game.chamber = ["blank"];
  game.liveRemaining = 0;
  game.blankRemaining = 1;
  game.dealerUseItems();
  assert.equal(game.current, game.dealer);
  assert.deepEqual(Array.from(game.dealer.inventory), ["Adrenaline"]);
  assert.deepEqual(Array.from(game.player.inventory), ["Beer"]);
  assert.equal(game.chamber.length, 1);
});


test("zero player health ends Story Mode immediately in every stage", () => {
  for (const stage of [1, 2, 3]) {
    const game = boot();
    game.start("story");
    game.stage = stage;
    game.player.health = 0;
    assert.equal(game.checkStageEnd(), true);
    assert.equal(game.gameOver, true);
    assert.equal(game.mode, "restart");
    assert.equal(game.stage, stage);
    assert.ok(game.events.some((event) => /ran out of health/i.test(event)));
  }
});

test("defeating the Dealer in Story stages 1 and 2 advances the stage", () => {
  const game = boot();
  game.start("story");
  game.dealer.health = 0;
  assert.equal(game.checkStageEnd(), true);
  assert.equal(game.stage, 2);
  assert.equal(game.gameOver, false);
  assert.equal(game.player.health, 4);
});

test("Story Mode payout deducts deaths, cigarettes and beer", () => {
  const game = boot();
  game.start("story");
  game.storyPenalty = 6000;
  game.cigarettesUsed = 2;
  game.beersUsed = 1;
  assert.equal(game.storyCash(), 63065);
});


test("reload clears unused handcuffs and gives the player the first turn", () => {
  const game = boot();
  game.start("story");
  game.player.handcuffed = true;
  game.dealer.handcuffed = true;
  game.current = game.dealer;
  game.reload();
  assert.equal(game.player.handcuffed, false);
  assert.equal(game.dealer.handcuffed, false);
  assert.equal(game.current, game.player);
});

test("Inverter preserves the user's knowledge of the shell it flips", () => {
  const game = boot();
  game.start("story");
  game.chamber = ["blank", "live", "blank"];
  game.liveRemaining = 1;
  game.blankRemaining = 2;
  game.knownShell.player = "blank";
  assert.equal(game.useItem(game.player, "Inverter"), true);
  assert.equal(game.chamber[0], "live");
  assert.equal(game.currentKnowledge(game.player), "live");
  assert.equal(game.liveRemaining, 2);
  assert.equal(game.blankRemaining, 1);
});

test("a blank self-shot keeps the turn, while shooting the Dealer ends it", () => {
  const game = boot();
  game.start("story");
  game.chamber = ["blank", "blank", "live"];
  game.liveRemaining = 1;
  game.blankRemaining = 2;
  game.shoot(game.player, game.player);
  assert.equal(game.current, game.player);
  game.shoot(game.player, game.dealer);
  assert.equal(game.current, game.dealer);
});

test("handcuffs skip the opponent's next turn exactly once", () => {
  const game = boot();
  game.start("story");
  game.dealer.handcuffed = true;
  game.chamber = ["live", "blank"];
  game.liveRemaining = 1;
  game.blankRemaining = 1;
  game.shoot(game.player, game.dealer);
  assert.equal(game.current, game.player);
  assert.equal(game.dealer.handcuffed, false);
});

test("Beer ejecting the final shell reloads and resets temporary turn effects", () => {
  const game = boot();
  game.start("story");
  game.chamber = ["blank"];
  game.liveRemaining = 0;
  game.blankRemaining = 1;
  game.isSawedOff = true;
  game.dealer.handcuffed = true;
  assert.equal(game.useItem(game.player, "Beer"), true);
  assert.ok(game.chamber.length >= 2);
  assert.equal(game.isSawedOff, false);
  assert.equal(game.dealer.handcuffed, false);
  assert.equal(game.current, game.player);
});

test("Story Mode stage transitions use the original health and item counts", () => {
  const game = boot();
  game.start("story");
  assert.equal(game.player.health, 2);
  assert.equal(game.dealer.health, 2);
  assert.equal(game.player.inventory.length, 0);

  game.stage = 2;
  game.beginStage();
  assert.equal(game.player.health, 4);
  assert.equal(game.dealer.health, 4);
  assert.equal(game.player.inventory.length, 2);
  assert.equal(game.dealer.inventory.length, 2);
  assert.equal(game.liveRemaining, 1);
  assert.equal(game.blankRemaining, 1);

  game.stage = 3;
  game.beginStage();
  assert.equal(game.player.health, 4);
  assert.equal(game.player.fadedHealth, 2);
  assert.equal(game.dealer.health, 4);
  assert.equal(game.dealer.fadedHealth, 2);
  assert.equal(game.player.inventory.length, 4);
  assert.equal(game.dealer.inventory.length, 4);
});

test("cut-wire participants cannot be healed and die on the next damage", () => {
  const game = boot();
  game.start("story");
  game.stage = 3;
  game.player.health = 1;
  game.player.fadedHealth = 2;
  game.damage(game.player, 1);
  assert.equal(game.player.cutWire, true);
  assert.equal(game.heal(game.player, 2), 0);
  game.damage(game.player, 1);
  assert.equal(game.player.dead, true);
});

test("Story stage 1 automatically advances after both scripted magazines", () => {
  const game = boot();
  game.start("story");
  game.player.health = 99;
  game.dealer.health = 99;
  while (game.stage === 1 && game.stageReloads === 1) {
    game.shoot(game.player, game.dealer);
  }
  assert.equal(game.stage, 1);
  assert.equal(game.stageReloads, 2);
  while (game.stage === 1 && game.chamber.length) {
    game.shoot(game.player, game.dealer);
  }
  assert.equal(game.stage, 2);
  assert.equal(game.player.health, 4);
  assert.equal(game.dealer.health, 4);
});


test("Adrenaline cannot select handcuffs when the target is already cuffed", () => {
  const game = boot();
  game.start("story");
  game.player.handcuffed = true;
  game.player.inventory = ["Handcuffs"];
  game.dealer.inventory = ["Adrenaline"];
  assert.equal(game.useItem(game.dealer, "Adrenaline"), false);
  assert.deepEqual(Array.from(game.player.inventory), ["Handcuffs"]);
  assert.deepEqual(Array.from(game.dealer.inventory), ["Adrenaline"]);
});

test("Dealer does not waste healing items after its cut wire", () => {
  const game = boot();
  game.start("story");
  game.stage = 3;
  game.dealer.health = 0;
  game.dealer.cutWire = true;
  game.dealer.inventory = ["Cigarette Pack", "Expired Medicine"];
  assert.equal(game.chooseDealerItem(), null);
});


test("Adrenaline excludes already-active Hand Saw and unavailable Burner Phone", () => {
  const game = boot();
  game.start("story");
  game.isSawedOff = true;
  game.chamber = ["live"];
  game.player.inventory = ["Hand Saw", "Burner Phone"];
  game.dealer.inventory = ["Adrenaline"];
  assert.equal(game.useItem(game.dealer, "Adrenaline"), false);
  assert.deepEqual(Array.from(game.player.inventory), ["Hand Saw", "Burner Phone"]);
  assert.deepEqual(Array.from(game.dealer.inventory), ["Adrenaline"]);
});


test("Adrenaline expires after the selection window and consumes itself", () => {
  const game = boot();
  game.start("story");
  game.player.inventory = ["Adrenaline"];
  game.dealer.inventory = ["Beer"];
  game.selectItem("1");
  assert.equal(game.mode, "steal");
  assert.equal(game.stealTimer, 1);
  assert.equal(game.scheduledTimers.findLast((timer) => !timer.interval).delay, 5000);
  game.expireAdrenaline();
  assert.equal(game.mode, "action");
  assert.deepEqual(Array.from(game.player.inventory), []);
  assert.deepEqual(Array.from(game.dealer.inventory), ["Beer"]);
});

test("choosing an Adrenaline target cancels its timeout and uses the stolen item", () => {
  const game = boot();
  game.start("story");
  game.player.inventory = ["Adrenaline"];
  game.dealer.inventory = ["Beer"];
  game.chamber = ["blank", "live"];
  game.liveRemaining = 1;
  game.blankRemaining = 1;
  game.selectItem("1");
  assert.equal(game.mode, "steal");
  game.handleSteal("1");
  assert.equal(game.stealTimer, null);
  assert.deepEqual(Array.from(game.player.inventory), []);
  assert.deepEqual(Array.from(game.dealer.inventory), []);
  assert.equal(game.mode, "action");
});





test("placing a bet starts Story Mode immediately without a mode-selection step", () => {
  const game = boot();
  game.tutorialSeen = true;
  game.submit("1");
  assert.equal(game.mode, "bet");
  game.submit("5");
  assert.equal(game.mode, "action");
  assert.equal(game.gameMode, "story");
  assert.equal(game.betAmount, 5);
  assert.equal(game.balance, 995);
});

test("a winning bet pays exactly double the stake", () => {
  const game = boot();
  game.betAmount = 25;
  game.balance = 975;
  game.settleBet(true);
  assert.equal(game.balance, 1025);
  assert.ok(game.events.some((event) => /Payout: \$50/.test(event)));
});

test("a losing bet does not return the stake", () => {
  const game = boot();
  game.betAmount = 25;
  game.balance = 975;
  game.settleBet(false);
  assert.equal(game.balance, 975);
});
