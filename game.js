(() => {
  "use strict";

  /*
   * Buckshot Browser — rules engine
   * Story mode and Double or Nothing are kept separate so that one mode's
   * randomisation and item pool cannot leak into the other.
   */

  const $ = (selector) => document.querySelector(selector);
  const screen = $("#screen");
  const form = $("#command-form");
  const input = $("#command-input");
  const promptLabel = $("#prompt-label");
  const keypad = $("#keypad");
  const keypadButtons = keypad.querySelectorAll("button");
  const DEALER_DELAY_MS = 5000;

  const BASE_ITEMS = [
    "Magnifying Glass", "Handcuffs", "Beer", "Cigarette Pack", "Hand Saw"
  ];
  const EXTRA_ITEMS = [
    "Adrenaline", "Burner Phone", "Inverter", "Expired Medicine"
  ];
  const ALL_ITEMS = [...BASE_ITEMS, ...EXTRA_ITEMS];

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pick = (array) => array[Math.floor(Math.random() * array.length)];

  class BuckshotGame {
    constructor() {
      this.player = this.makeEntity("Player");
      this.dealer = this.makeEntity("Dealer");
      this.current = this.player;
      this.opponent = this.dealer;
      this.mode = "menu";
      this.gameMode = "story";
      this.bankruptcyDeferred = false;
      this.balance = this.loadBalance();
      this.mode = "menu";
      this.betAmount = 0;
      this.betSettled = false;
      this.doubleUnlocked = this.loadDoubleOrNothingUnlock();
      this.stage = 1;
      this.reloadNumber = 0;
      this.stageReloads = 0;
      this.chamber = [];
      this.liveRemaining = 0;
      this.blankRemaining = 0;
      this.knownShell = { player: null, dealer: null };
      this.futureKnowledge = { player: {}, dealer: {} };
      this.isSawedOff = false;
      this.events = [];
      this.results = [];
      this.gameOver = false;
      this.busy = false;
      this.timer = null;
      this.stealTimer = null;
      this.setNumber = 1;
      this.winnings = 0;
      this.setStartedAt = 0;
      this.storyPenalty = 0;
      this.cigarettesUsed = 0;
      this.beersUsed = 0;
      this.stealableItems = [];
      this.stealOwner = null;
      this.render();
      screen.addEventListener("click", (event) => {
        const choice = event.target.closest("[data-main-mode]");
        if (choice && !choice.disabled && this.mode === "menu") this.submit(choice.dataset.mainMode);
      });
      document.addEventListener("keydown", (event) => {
        if (this.mode !== "menu" || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
        if (event.key === "1" || event.key === "2") {
          event.preventDefault();
          this.submit(event.key);
        }
      });
    }

    makeEntity(name) {
      return {
        name, health: 0, maxHealth: 0, fadedHealth: 0, cutWire: false, dead: false,
        inventory: [], handcuffed: false
      };
    }

    entityKey(entity) {
      return entity === this.player ? "player" : "dealer";
    }

    addEvent(message) {
      this.events.push(message);
      if (this.events.length > 12) this.events.shift();
    }

    escape(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    submit(raw) {
      const command = String(raw).trim().toLowerCase();
      if (this.mode === "menu") {
        if (command === "1") {
          this.mode = this.balance <= 300 && !this.bankruptcyDeferred ? "bankruptcy" : "bet";
          this.render();
        } else if (command === "2") {
          window.dispatchEvent(new CustomEvent("buckshot:mode", { detail: "multiplayer" }));
        }
        return;
      }
      if (this.mode === "bet") {
        if (!/^\d+$/.test(command)) {
          this.addEvent("Enter a whole-number bet, or 0 to play without betting.");
          this.render();
          return;
        }
        const amount = Number(command);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.balance) {
          this.addEvent(`Choose an amount between 0 and ${this.balance.toLocaleString()}.`);
          this.render();
          return;
        }
        this.betAmount = amount;
        this.betSettled = false;
        this.balance -= amount;
        this.saveBalance();
        this.mode = "start";
        this.addEvent(amount ? "Bet placed: $" + amount.toLocaleString() + "." : "Free play selected. No bet placed.");
        this.render();
        return;
      }
      if (this.mode === "bankruptcy") {
        if (command === "1" || command === "y") this.claimBenefactorBailout();
        else if (command === "2" || command === "n" || command === "") {
          this.bankruptcyDeferred = true;
          this.mode = "restart";
          this.addEvent("You declined the benefactor's offer. The lifeline remains unclaimed.");
        } else {
          this.addEvent("Choose 1 to file bankruptcy or 2 to decline for now.");
        }
        this.render();
        return;
      }
      if (this.mode === "start") {
        if (command === "2" && !this.doubleUnlocked) {
          this.addEvent("Double or Nothing is locked. Win Story Mode once to unlock it.");
          this.render();
          return;
        }
        this.start(command === "2" ? "double" : "story");
        return;
      }
      if (this.mode === "restart") {
        if (command === "r" || command === "") this.reset();
        else this.addEvent("Enter R to start a new game.");
        this.render();
        return;
      }
      if (this.mode === "cashout") {
        if (command === "1" || command === "y") this.startNextSet();
        else if (command === "2" || command === "n" || command === "") this.finishDoubleRun();
        else this.addEvent("Choose 1 to double down or 2 to cash out.");
        this.render();
        return;
      }
      if (this.mode === "item") {
        this.selectItem(command);
        return;
      }
      if (this.mode === "steal") {
        this.handleSteal(command);
        return;
      }
      if (this.mode !== "action" || this.busy || this.current !== this.player) return;

      if (command === "1") this.shoot(this.player, this.dealer);
      else if (command === "2") this.shoot(this.player, this.player);
      else if (command === "3") this.openInventory();
      else this.addEvent("Choose 1, 2, or 3.");
      this.afterPlayerCommand();
    }

    loadBalance() {
      try {
        const stored = window.localStorage?.getItem("buckshot-browser.balance");
        if (stored === null || stored === undefined) return 1000;
        const saved = Number(stored);
        return Number.isSafeInteger(saved) && saved >= 0 ? saved : 1000;
      } catch {
        return 1000;
      }
    }

    saveBalance() {
      try {
        window.localStorage?.setItem("buckshot-browser.balance", String(this.balance));
      } catch {
        // The wallet remains available for this session if storage is blocked.
      }
    }

    settleBet(playerWon) {
      if (this.betSettled) return;
      this.betSettled = true;
      if (!this.betAmount) {
        this.addEvent("No wager was placed. Your balance is unchanged.");
      } else if (playerWon) {
        const payout = this.betAmount * 2;
        this.balance += payout;
        this.addEvent("BET WON: +$" + this.betAmount.toLocaleString() + " profit. Payout: $" + payout.toLocaleString() + ".");
        this.saveBalance();
      } else {
        this.addEvent("BET LOST: -$" + this.betAmount.toLocaleString() + ".");
      }
      this.maybeOfferBankruptcy();
    }

    getBenefactorNextAvailable() {
      try {
        const stored = Number(window.localStorage?.getItem("buckshot-browser.benefactor-next-available"));
        return Number.isFinite(stored) && stored > 0 ? stored : 0;
      } catch {
        return 0;
      }
    }

    formatIst(timestamp) {
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
        hour12: true
      }).format(new Date(timestamp)) + " IST";
    }

    nextIstBenefactorSlotAfterFortyEightHours(timestamp) {
      const target = timestamp + 48 * 60 * 60 * 1000;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date(target));
      const part = (type) => Number(parts.find((entry) => entry.type === type).value);
      let midnight = Date.UTC(part("year"), part("month") - 1, part("day"), -5, -30);
      if (midnight < target) midnight += 24 * 60 * 60 * 1000;
      const istDateNumber = Math.floor((midnight + 5.5 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
      if (istDateNumber % 2 !== 0) midnight += 24 * 60 * 60 * 1000;
      return midnight;
    }

    maybeOfferBankruptcy() {
      if (this.balance <= 300 && !this.bankruptcyDeferred) {
        this.mode = "bankruptcy";
        this.addEvent("Your wallet has fallen to 300 or less. The benefactor's lifeline is available to review.");
      }
    }

    claimBenefactorBailout() {
      const now = Date.now();
      const nextAvailable = this.getBenefactorNextAvailable();
      if (nextAvailable > now) {
        this.addEvent("The benefactor is not ready to help yet. Next availability: " + this.formatIst(nextAvailable) + ".");
        return;
      }
      this.balance += 500;
      this.saveBalance();
      const nextPayout = this.nextIstBenefactorSlotAfterFortyEightHours(now);
      try {
        window.localStorage?.setItem("buckshot-browser.benefactor-next-available", String(nextPayout));
      } catch {
        // The claim remains active for this session if storage is blocked.
      }
      this.bankruptcyDeferred = false;
      this.mode = "restart";
      this.addEvent("The anonymous benefactor sends you 500 in cash. Next lifeline: " + this.formatIst(nextPayout) + ".");
    }

    loadDoubleOrNothingUnlock() {
      try {
        return window.localStorage?.getItem("buckshot-browser.double-or-nothing-unlocked") === "true";
      } catch {
        return false;
      }
    }

    unlockDoubleOrNothing() {
      this.doubleUnlocked = true;
      try {
        window.localStorage?.setItem("buckshot-browser.double-or-nothing-unlocked", "true");
      } catch {
        // The unlock remains available for this session if storage is blocked.
      }
    }

    start(mode) {
      this.gameMode = mode;
      this.stage = 1;
      this.setNumber = 1;
      this.winnings = 0;
      this.storyPenalty = 0;
      this.cigarettesUsed = 0;
      this.beersUsed = 0;
      this.results = [];
      this.events = [];
      this.gameOver = false;
      this.setStartedAt = Date.now();
      this.beginStage(true);
    }

    reset() {
      if (this.timer) clearTimeout(this.timer);
      if (this.stealTimer) window.clearTimeout(this.stealTimer);
      this.timer = null;
      this.stealTimer = null;
      this.player = this.makeEntity("Player");
      this.dealer = this.makeEntity("Dealer");
      this.current = this.player;
      this.opponent = this.dealer;
      this.reloadNumber = 0;
      this.stageReloads = 0;
      this.chamber = [];
      this.events = [];
      this.results = [];
      this.gameOver = false;
      this.busy = false;
      this.mode = this.balance <= 300 && !this.bankruptcyDeferred ? "bankruptcy" : "bet";
      this.betAmount = 0;
      this.betSettled = false;
      this.render();
    }

    beginStage(firstStage = false) {
      this.stageReloads = 0;
      this.reloadNumber = 0;
      this.chamber = [];
      this.isSawedOff = false;
      this.knownShell = { player: null, dealer: null };
      this.futureKnowledge = { player: {}, dealer: {} };
      const sharedHealth = this.gameMode === "story" ? (this.stage === 1 ? 2 : 4) : randomInt(2, 4);
      for (const entity of [this.player, this.dealer]) {
        entity.inventory = [];
        entity.handcuffed = false;
        entity.cutWire = false;
        entity.dead = false;
        entity.maxHealth = sharedHealth;
        entity.health = sharedHealth;
        entity.fadedHealth = this.gameMode === "story" && this.stage === 3 ? 2 : 0;
      }
      this.current = this.player;
      this.opponent = this.dealer;
      this.addEvent(firstStage
        ? (this.gameMode === "story" ? "The Dealer welcomes you. Story Mode." : "You swallow the pills. Double or Nothing.")
        : `Stage ${this.stage} begins.`);
      this.mode = "action";
      this.reload();
      this.render();
    }

    itemCountForReload() {
      if (this.gameMode === "double") return randomInt(1, 5);
      if (this.stage === 1) return 0;
      return this.stage === 2 ? 2 : 4;
    }

    distributeItems() {
      const count = this.itemCountForReload();
      const pool = this.gameMode === "story" ? BASE_ITEMS : ALL_ITEMS;
      for (const entity of [this.player, this.dealer]) {
        for (let i = 0; i < count && entity.inventory.length < 8; i++) entity.inventory.push(pick(pool));
      }
      if (count) this.addEvent(`Both sides receive up to ${count} item(s), subject to the 8-slot limit.`);
    }

    reload() {
      this.reloadNumber += 1;
      this.stageReloads += 1;
      let shells;

      if (this.gameMode === "story" && this.stage === 1) {
        const preset = this.stageReloads === 1
          ? ["live", "blank", "blank"]
          : ["live", "live", "live", "blank", "blank"];
        shells = [...preset];
      } else if (this.gameMode === "story" && this.stage === 2 && this.stageReloads === 1) {
        shells = ["live", "blank"];
      } else {
        const total = randomInt(2, 8);
        let live = Math.floor(total / 2);
        let blank = Math.floor(total / 2);
        if (total % 2) {
          if (Math.random() < 0.5) live++;
          else blank++;
        }
        shells = [...Array(live).fill("live"), ...Array(blank).fill("blank")];
      }

      this.shuffle(shells);
      this.chamber = shells;
      this.liveRemaining = shells.filter((s) => s === "live").length;
      this.blankRemaining = shells.length - this.liveRemaining;
      this.isSawedOff = false;
      // A fresh magazine clears any unused handcuff effect.
      this.player.handcuffed = false;
      this.dealer.handcuffed = false;
      this.knownShell = { player: null, dealer: null };
      this.futureKnowledge = { player: {}, dealer: {} };
      this.distributeItems();
      this.addEvent(`Reload ${this.reloadNumber}: ${shells.length} shells (${this.liveRemaining} live, ${this.blankRemaining} blank).`);
      this.current = this.player;
      this.opponent = this.dealer;
      this.mode = "action";
    }

    shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
      return array;
    }

    inferCurrentShell() {
      if (this.liveRemaining === 0) return "blank";
      if (this.blankRemaining === 0) return "live";
      return null;
    }

    currentKnowledge(entity) {
      const key = this.entityKey(entity);
      if (this.knownShell[key]) return this.knownShell[key];
      if (this.futureKnowledge[key][0]) return this.futureKnowledge[key][0];
      let live = this.liveRemaining;
      let blank = this.blankRemaining;
      for (const [position, shell] of Object.entries(this.futureKnowledge[key])) {
        if (Number(position) <= 0) continue;
        if (shell === "live") live--;
        else blank--;
      }
      if (live === 0) return "blank";
      if (blank === 0) return "live";
      return null;
    }

    drawShell() {
      const shell = this.chamber.shift();
      if (!shell) return null;
      if (shell === "live") this.liveRemaining--;
      else this.blankRemaining--;
      for (const key of ["player", "dealer"]) {
        const shifted = {};
        for (const [position, known] of Object.entries(this.futureKnowledge[key])) {
          const next = Number(position) - 1;
          if (next >= 0) shifted[next] = known;
        }
        this.futureKnowledge[key] = shifted;
      }
      this.knownShell = { player: null, dealer: null };
      return shell;
    }

    shoot(shooter, target) {
      if (this.chamber.length === 0) this.reload();
      const shell = this.drawShell();
      const damage = this.isSawedOff ? 2 : 1;
      this.isSawedOff = false;

      if (shell === "live") {
        this.damage(target, damage);
        this.addEvent(`${shooter.name} fires a LIVE shell at ${target.name}: ${damage} damage.`);
        this.passTurn(shooter);
      } else {
        this.addEvent(`${shooter.name} fires a BLANK shell at ${target.name}.`);
        if (target !== shooter) this.passTurn(shooter);
        else this.addEvent(`${shooter.name} keeps the turn.`);
      }
      this.resolveAfterShot();
    }

    damage(entity, amount) {
      for (let i = 0; i < amount; i++) {
        if (this.gameMode === "story" && this.stage === 3 && entity.cutWire) {
          entity.dead = true;
        } else if (entity.health > 0) {
          entity.health--;
          if (this.gameMode === "story" && this.stage === 3 && entity.health === 0) entity.cutWire = true;
        } else {
          entity.dead = true;
        }
      }
    }

    heal(entity, amount) {
      if (entity.cutWire || entity.dead) return 0;
      const healed = Math.min(amount, entity.maxHealth - entity.health);
      entity.health += healed;
      return healed;
    }

    passTurn(shooter) {
      this.current = shooter === this.player ? this.dealer : this.player;
      this.opponent = shooter;
      this.applyCuffSkip();
    }

    applyCuffSkip() {
      if (!this.current.handcuffed) return;
      const skipped = this.current;
      skipped.handcuffed = false;
      this.addEvent(`${skipped.name} loses this turn because of the handcuffs.`);
      this.current = skipped === this.player ? this.dealer : this.player;
      this.opponent = skipped;
    }

    resolveAfterShot() {
      if (this.checkStageEnd()) return;
      if (this.chamber.length === 0) {
        if (this.gameMode === "story" && this.stage === 1 && this.stageReloads >= 2) {
          this.advanceStage();
          return;
        }
        this.reload();
      }
    }

    calculateTimedPayout(elapsedSeconds) {
      return Math.max(10, Math.floor(70000 - (elapsedSeconds * 200 / 3)));
    }

    checkStageEnd() {
      // The player's run ends immediately at zero health in every mode and stage.
      const playerDead = this.player.dead || this.player.health <= 0;
      const dealerDead = this.dealer.dead || (this.dealer.health <= 0 && (this.gameMode === "double" || this.stage < 3));
      if (!playerDead && !dealerDead) return false;

      const playerWon = !playerDead && dealerDead;
      this.results.push(`Stage ${this.stage}: ${playerWon ? "Player" : "Dealer"} wins`);
      this.addEvent(`Stage ${this.stage} ends. ${playerWon ? "You win." : "The Dealer wins."}`);

      if (this.gameMode === "story") {
        if (playerDead) {
          this.gameOver = true;
          this.mode = "restart";
          this.addEvent("You ran out of health. Story Mode is over.");
          this.settleBet(false);
          this.addEvent(`Final Story Mode cash: ${this.storyCash().toLocaleString()}.`);
        } else if (this.stage < 3) {
          this.advanceStage();
        } else if (playerWon) {
          this.gameOver = true;
          this.mode = "restart";
          this.unlockDoubleOrNothing();
          this.addEvent("You survived Story Mode. The briefcase is yours.");
          this.settleBet(true);
          this.addEvent(`Final Story Mode cash: ${this.storyCash().toLocaleString()}.`);
        } else {
          this.gameOver = true;
          this.mode = "restart";
          this.addEvent("The Dealer wins. You did not survive the final stage.");
          this.settleBet(false);
          this.addEvent(`Final Story Mode cash: ${this.storyCash().toLocaleString()}.`);
        }
      } else if (!playerWon) {
        this.gameOver = true;
        this.mode = "restart";
        this.winnings = 0;
        this.settleBet(false);
        this.addEvent("Run over. Double or Nothing pays nothing when you lose.");
      } else if (this.stage < 3) {
        this.advanceStage();
      } else {
        if (this.setNumber === 1) {
          const elapsedSeconds = (Date.now() - this.setStartedAt) / 1000;
          this.winnings = this.calculateTimedPayout(elapsedSeconds);
          this.addEvent(`Initial set cleared. Your starting payout is ${this.winnings.toLocaleString()}.`);
        } else {
          this.winnings *= 2;
          this.addEvent(`Double successful. Your running payout is now ${this.winnings.toLocaleString()}.`);
        }
        this.mode = "cashout";
      }
      this.render();
      return true;
    }

    advanceStage() {
      this.stage += 1;
      if (this.stage > 3) {
        this.stage = 3;
        this.mode = "cashout";
        this.render();
        return;
      }
      this.beginStage();
    }

    startNextSet() {
      this.setNumber += 1;
      this.stage = 1;
      this.player = this.makeEntity("Player");
      this.dealer = this.makeEntity("Dealer");
      this.current = this.player;
      this.opponent = this.dealer;
      this.beginStage();
    }

    storyCash() {
      return Math.max(0, 70000 - this.storyPenalty - this.cigarettesUsed * 220 - this.beersUsed * 495);
    }

    finishDoubleRun() {
      this.gameOver = true;
      this.mode = "restart";
      this.settleBet(true);
      this.addEvent("You cash out with $" + this.winnings.toLocaleString() + ".");
      this.render();
    }

    openInventory() {
      if (!this.player.inventory.length) {
        this.addEvent("Your inventory is empty.");
        return;
      }
      this.mode = "item";
      this.addEvent("Choose an item number (0 to return):");
      this.player.inventory.forEach((item, i) => this.addEvent(`${i + 1}. ${item}`));
    }

    selectItem(command) {
      if (command === "0") {
        this.mode = "action";
        this.render();
        return;
      }
      const index = Number(command) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= this.player.inventory.length) {
        this.addEvent("Choose a listed item, or 0 to return.");
        this.render();
        return;
      }
      const item = this.player.inventory[index];
      const result = this.useItem(this.player, item);
      if (result === "steal") {
        this.mode = "steal";
      } else if (result) {
        this.consumeItem(this.player, item);
        this.mode = "action";
        this.checkStageEnd();
      }
      this.render();
    }

    handleSteal(command) {
      const index = Number(command) - 1;
      const item = this.stealableItems[index];
      if (!item) {
        this.addEvent("Choose a listed item to steal.");
        this.render();
        return;
      }
      if (this.stealTimer) window.clearTimeout(this.stealTimer);
      this.stealTimer = null;
      const owner = this.stealOwner;
      const victim = owner === this.player ? this.dealer : this.player;
      const victimIndex = victim.inventory.indexOf(item);
      if (victimIndex < 0) {
        this.mode = "action";
        this.render();
        return;
      }
      victim.inventory.splice(victimIndex, 1);
      this.addEvent(`${owner.name} steals ${item} and uses it immediately.`);
      const success = this.useItem(owner, item, true);
      if (!success) victim.inventory.push(item);
      else this.consumeItem(owner, "Adrenaline");
      this.stealableItems = [];
      this.stealOwner = null;
      this.mode = "action";
      this.checkStageEnd();
      this.render();
    }

    consumeItem(owner, item) {
      const index = owner.inventory.indexOf(item);
      if (index >= 0) owner.inventory.splice(index, 1);
    }

    expireAdrenaline() {
      if (this.mode !== "steal" || this.stealOwner !== this.player) return;
      this.stealTimer = null;
      this.consumeItem(this.player, "Adrenaline");
      this.stealableItems = [];
      this.stealOwner = null;
      this.mode = "action";
      this.addEvent("Adrenaline expired. No item was stolen.");
      this.afterPlayerCommand();
    }

    useItem(owner, item, stolen = false) {
      const other = owner === this.player ? this.dealer : this.player;
      const key = this.entityKey(owner);
      if (this.chamber.length === 0 && ["Magnifying Glass", "Beer", "Inverter", "Burner Phone"].includes(item)) {
        this.addEvent("There is no shell to interact with.");
        return false;
      }

      switch (item) {
        case "Magnifying Glass": {
          const shell = this.currentKnowledge(owner) || this.chamber[0];
          this.knownShell[key] = shell;
          this.addEvent(`${owner.name} checks the chamber: ${shell.toUpperCase()}.`);
          return true;
        }
        case "Handcuffs":
          if (other.handcuffed) return false;
          other.handcuffed = true;
          this.addEvent(`${other.name} is handcuffed and will miss their next turn.`);
          return true;
        case "Beer": {
          const ejected = this.drawShell();
          if (owner === this.player) this.beersUsed++;
          this.isSawedOff = false;
          this.addEvent(`${owner.name} racks the shotgun and ejects a ${ejected.toUpperCase()} shell.`);
          if (!this.chamber.length) this.reload();
          return true;
        }
        case "Cigarette Pack": {
          if (owner === this.player) this.cigarettesUsed++;
          const healed = this.heal(owner, 1);
          this.addEvent(healed ? `${owner.name} restores 1 charge.` : `${owner.name} is already at maximum normal health.`);
          return true;
        }
        case "Hand Saw":
          if (this.isSawedOff) return false;
          this.isSawedOff = true;
          this.addEvent(`${owner.name} saws off the barrel. The next live shot deals 2 damage.`);
          return true;
        case "Inverter": {
          const flipped = this.chamber[0] === "live" ? "blank" : "live";
          this.chamber[0] = flipped;
          if (flipped === "live") { this.liveRemaining++; this.blankRemaining--; }
          else { this.liveRemaining--; this.blankRemaining++; }
          // Preserve any information already held about this exact shell.
          // The user of the inverter also knows what they changed it into.
          for (const participant of ["player", "dealer"]) {
            if (this.knownShell[participant]) this.knownShell[participant] = flipped;
            if (this.futureKnowledge[participant][0]) this.futureKnowledge[participant][0] = flipped;
          }
          this.knownShell[key] = flipped;
          this.addEvent(`${owner.name} inverts the current shell to ${flipped.toUpperCase()}.`);
          return true;
        }
        case "Burner Phone": {
          if (this.chamber.length < 2) return false;
          const unknownPositions = this.chamber
            .map((_, index) => index)
            .filter((index) => index > 0 && !this.futureKnowledge[key][index]);
          if (!unknownPositions.length) return false;
          // Reveal the nearest unseen future shell so the information is
          // likely to become actionable before the magazine runs out.
          const index = unknownPositions[0];
          const future = this.chamber[index];
          this.futureKnowledge[key][index] = future;
          this.addEvent(`The Burner Phone reveals shell ${index + 1}: ${future.toUpperCase()}.`);
          return true;
        }
        case "Expired Medicine": {
          if (Math.random() < 0.5) {
            const healed = this.heal(owner, 2);
            this.addEvent(`Medicine works: ${healed} charge(s) restored.`);
          } else {
            this.damage(owner, 1);
            this.addEvent("Medicine backfires: you lose 1 charge.");
          }
          return true;
        }
        case "Adrenaline": {
          const candidates = other.inventory.filter((candidate) =>
            candidate !== "Adrenaline" &&
            !(candidate === "Handcuffs" && other.handcuffed) &&
            !(candidate === "Hand Saw" && this.isSawedOff) &&
            !(candidate === "Burner Phone" && this.chamber.length < 2)
          );
          if (!candidates.length) return false;
          if (owner === this.player && !stolen) {
            this.stealableItems = candidates;
            this.stealOwner = owner;
            this.addEvent("Choose an opponent item to steal within 5 seconds:");
            candidates.forEach((candidate, i) => this.addEvent(`${i + 1}. ${candidate}`));
            this.stealTimer = window.setTimeout(() => this.expireAdrenaline(), 5000);
            return "steal";
          }
          const chosen = this.chooseDealerSteal(candidates);
          const victimIndex = other.inventory.indexOf(chosen);
          other.inventory.splice(victimIndex, 1);
          this.addEvent(`${owner.name} steals ${chosen} and uses it.`);
          const success = this.useItem(owner, chosen, true);
          if (!success) other.inventory.push(chosen);
          return success;
        }
        default:
          return false;
      }
    }

    dealerItemValue(item, owner = this.dealer) {
      const other = owner === this.player ? this.dealer : this.player;
      const known = this.currentKnowledge(owner);
      const mixedShells = this.liveRemaining > 0 && this.blankRemaining > 0;
      const canHeal = !owner.cutWire && !owner.dead && owner.health < owner.maxHealth;
      const missingHealth = owner.maxHealth - owner.health;

      switch (item) {
        case "Cigarette Pack":
          return canHeal ? 120 + Math.min(1, missingHealth) : -1;
        case "Handcuffs":
          return !other.handcuffed ? 105 : -1;
        case "Adrenaline":
          return -1;
        case "Magnifying Glass":
          return !known && mixedShells ? 90 : -1;
        case "Inverter":
          return known === "blank" && this.chamber.length ? 115 : -1;
        case "Hand Saw":
          if (this.isSawedOff) return -1;
          if (known === "live") return 110;
          if (!known && this.liveRemaining > this.blankRemaining) return 65;
          return -1;
        case "Beer":
          return known === "blank" && this.chamber.length > 1 ? 100 : -1;
        case "Burner Phone":
          return this.chamber.length > 1 &&
            this.chamber.some((_, index) => index > 0 && !this.futureKnowledge[this.entityKey(owner)][index])
            ? 70 : -1;
        case "Expired Medicine":
          return !owner.cutWire && !owner.dead && owner.health >= 2 &&
            missingHealth >= 2 ? 55 : -1;
        default:
          return -1;
      }
    }

    chooseDealerSteal(candidates) {
      // Steal the item with the greatest immediate tactical value, not just
      // the first item in a fixed priority list.
      return candidates
        .map((item) => ({ item, value: this.dealerItemValue(item, this.dealer) }))
        .filter((entry) => entry.value >= 0)
        .sort((a, b) => b.value - a.value)[0]?.item || null;
    }

    dealerUseItems() {
      // The dealer only uses its own inventory and information it has acquired.
      let guard = 0;
      while (this.dealer.inventory.length && guard++ < 8) {
        const item = this.chooseDealerItem();
        if (!item) break;
        const result = this.useItem(this.dealer, item);
        if (result === "steal") break;
        if (result) this.consumeItem(this.dealer, item);
        if (this.checkStageEnd()) return;
        // A Beer/Adrenaline effect can empty the magazine and trigger a reload.
        // The player owns the first action of every fresh magazine.
        if (this.current !== this.dealer) return;
      }
    }

    chooseDealerItem() {
      const inventory = this.dealer.inventory;
      if (!inventory.length) return null;

      // Adrenaline is valuable when it can immediately steal and activate
      // something useful. Avoid spending it on an item with no current value.
      const stealable = this.player.inventory.filter((item) =>
        item !== "Adrenaline" &&
        !(item === "Handcuffs" && this.player.handcuffed) &&
        !(item === "Hand Saw" && this.isSawedOff) &&
        !(item === "Burner Phone" && this.chamber.length < 2)
      );
      const stolenItem = this.chooseDealerSteal(stealable);
      const scored = inventory.map((item) => {
        let value = this.dealerItemValue(item, this.dealer);
        if (item === "Adrenaline") value = stolenItem ? 108 + this.dealerItemValue(stolenItem, this.dealer) / 10 : -1;
        return { item, value };
      });

      // Re-evaluate after every use. This naturally enables combinations:
      // inspect -> invert a known blank -> saw the resulting live shell.
      return scored
        .filter((entry) => entry.value >= 0)
        .sort((a, b) => b.value - a.value)[0]?.item || null;
    }

    runDealerTurn() {
      if (this.gameOver || this.current !== this.dealer) {
        this.render();
        return;
      }
      if (this.dealer.handcuffed) {
        this.dealer.handcuffed = false;
        this.addEvent("The Dealer loses a turn because of the handcuffs.");
        this.current = this.player;
        this.opponent = this.dealer;
        this.render();
        return;
      }
      this.busy = true;
      this.mode = "waiting";
      this.addEvent("The Dealer is thinking...");
      this.render();
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (this.gameOver) return;
        this.mode = "action";
        this.dealerUseItems();
        if (!this.gameOver && this.current === this.dealer) {
          const known = this.currentKnowledge(this.dealer);
          const shell = known || (this.liveRemaining === 0 ? "blank" : this.blankRemaining === 0 ? "live" : null);
          let target;
          if (shell === "blank") target = this.dealer;
          else if (shell === "live") target = this.player;
          else target = this.liveRemaining > this.blankRemaining ? this.player : this.dealer;
          this.shoot(this.dealer, target);
        }
        this.busy = false;
        if (!this.gameOver && this.current === this.dealer) this.runDealerTurn();
        else this.render();
      }, DEALER_DELAY_MS);
    }

    afterPlayerCommand() {
      if (this.mode === "item" || this.mode === "steal") {
        this.render();
        return;
      }
      if (this.checkStageEnd()) return;
      if (this.current === this.dealer) this.runDealerTurn();
      else this.render();
    }

    render() {
      if (this.mode === "menu") {
        screen.innerHTML = [
          '<span class="title">BUCKSHOT ROULETTE</span>', "",
          `CURRENT BALANCE: ${this.balance.toLocaleString()}`, "",
          '<button class="menu-choice" type="button" data-main-mode="1">&gt; [ 1 ] : STORY MODE</button>',
          '<button class="menu-choice" type="button" data-main-mode="2">&gt; [ 2 ] : MULTIPLAYER</button>'
        ].join("\n");
        promptLabel.textContent = "Select mode:";
        input.disabled = true;
        keypadButtons.forEach((button) => button.disabled = true);
        return;
      }

      if (this.mode === "bet") {
        screen.innerHTML = [
          '<span class="title">BUCKSHOT ROULETTE</span>', "",
          `CURRENT BALANCE: ${this.balance.toLocaleString()}`,
          '<span class="bet-note">[ WINNING BET PAYS OUT DOUBLE YOUR STAKE ]</span>'
        ].join("\n");
        promptLabel.textContent = "> ENTER BET AMOUNT: ";
        input.disabled = false;
        if (!input.readOnly) input.focus();
        keypadButtons.forEach((b) => b.disabled = false);
        return;
      }

      if (this.mode === "bankruptcy") {
        const nextAvailable = this.getBenefactorNextAvailable();
        const available = nextAvailable <= Date.now();
        screen.innerHTML = [
          '<span class="bankruptcy-title">YOU\'RE BANKRUPT</span>',
          "THE DEALER HAS TAKEN EVERYTHING",
          "",
          "FORTUNATELY, AN ANONYMOUS BENEFACTOR WANTS TO OFFER YOU 500 IN CASH.",
          "THIS IS YOUR ONLY LIFELINE FOR THE NEXT 2 DAYS. DONT WASTE IT.",
          "",
          `CURRENT BALANCE: ${this.balance.toLocaleString()}`,
          available ? "1. FILE BANKRUPTCY — CLAIM 500 CASH" : "THE BENEFACTOR IS NOT READY TO HELP YET.",
          available ? "2. NOT NOW — KEEP PLAYING" : "NEXT LIFELINE: " + this.formatIst(nextAvailable),
          "",
          '<span class="separator">---</span>'
        ].join("\n");
        promptLabel.textContent = available ? "1 to claim / 2 to decline:" : "2 to continue:";
        input.disabled = false;
        if (!input.readOnly) input.focus();
        keypadButtons.forEach((b) => b.disabled = false);
        return;
      }

      if (this.mode === "start") {
        screen.innerHTML = [
          '<span class="title">BUCKSHOT ROULETTE</span>', "",
          `CURRENT BALANCE: ${this.balance.toLocaleString()}`,
          `YOUR BET: ${this.betAmount ? "$" + this.betAmount.toLocaleString() + " | WIN: +$" + this.betAmount.toLocaleString() + " | PAYOUT: $" + (this.betAmount * 2).toLocaleString() : "NONE"}`, "",
          "1. Story Mode",
          this.doubleUnlocked ? "2. Double or Nothing" : "2. Double or Nothing (locked)",
          "",
          this.doubleUnlocked
            ? "Press Enter for Story Mode, or enter 2 for Double or Nothing."
            : "Win Story Mode once to unlock Double or Nothing.",
          "", '<span class="separator">---</span>'
        ].join("\n");
        promptLabel.textContent = "Mode:";
        input.disabled = false;
        if (!input.readOnly) input.focus();
        keypadButtons.forEach((b) => b.disabled = false);
        return;
      }

      const health = (entity) => entity.fadedHealth
        ? `${entity.health} + ${entity.fadedHealth} cracked${entity.cutWire ? " (wire cut)" : ""}`
        : String(entity.health);
      const lines = [
        `<span class="title">==== ${this.gameMode === "story" ? "STORY" : "DOUBLE OR NOTHING"} | STAGE ${this.stage} | RELOAD ${this.reloadNumber} ====</span>`,
        "",
        `CURRENT BALANCE: ${this.balance.toLocaleString()}`,
        `ACTIVE BET: ${this.betAmount ? "$" + this.betAmount.toLocaleString() + " | WIN: +$" + this.betAmount.toLocaleString() + " | PAYOUT: $" + (this.betAmount * 2).toLocaleString() : "NONE"}`,
        "",
        `SHELLS: ${this.chamber.length} ( ${this.liveRemaining} LIVE / ${this.blankRemaining} BLANK )`,
        `PLAYER LIVES: ${health(this.player)}`,
        `DEALER LIVES: ${health(this.dealer)}`,
        "",
        `PLAYER ITEMS [${this.player.inventory.length}]: ${this.player.inventory.join(", ") || "none"}`,
        `DEALER ITEMS [${this.dealer.inventory.length}]: ${this.dealer.inventory.join(", ") || "none"}`,
        "",
        ...this.results.map((r) => `> ${this.escape(r)}`),
        '<span class="separator">---</span>', ""
      ];

      if (this.mode === "cashout") {
        lines.push(`RUNNING WINNINGS: $${this.winnings.toLocaleString()}`, "1. Double down", "2. Cash out");
      } else if (this.mode === "restart") {
        lines.push("GAME OVER", `FINAL CASH: ${(this.gameMode === "story" ? this.storyCash() : this.winnings).toLocaleString()}`, "Press R to restart.");
      } else {
        lines.push("1. Shoot the Dealer", "2. Shoot Yourself", "3. Use an item");
      }
      lines.push("", '<span class="separator">---</span>', "");
      if (this.mode !== "restart" && this.mode !== "cashout") {
        lines.push(`<span class="status">(${this.current.name}'s turn)${this.busy ? " — waiting" : ""}</span>`);
      }
      lines.push("", '<span class="title">RECENT EVENTS:</span>');
      const previousEventLog = screen.querySelector(".event-log");
      const wasAtEventLogBottom = !previousEventLog ||
        previousEventLog.scrollHeight - previousEventLog.clientHeight - previousEventLog.scrollTop < 24;
      const eventMarkup = this.events.slice(-8)
        .map((event) => `<div class="event">&gt; ${this.escape(event)}</div>`)
        .join("");
      screen.innerHTML = `${lines.join("\n")}<div class="event-log" role="log" aria-label="Recent events" aria-live="polite">${eventMarkup}</div>`;
      const eventLog = screen.querySelector(".event-log");
      if (wasAtEventLogBottom) eventLog.scrollTop = eventLog.scrollHeight;

      const prompts = {
        item: "Item number:", steal: "Steal item number:",
        waiting: "Dealer:", cashout: "Choose 1 or 2:",
        bankruptcy: "1 to claim / 2 to decline:",
        restart: "R to restart:", action: "Select an action:"
      };
      promptLabel.textContent = prompts[this.mode] || "Command:";
      input.disabled = this.mode === "waiting";
      if (!input.disabled && !input.readOnly) input.focus();
      keypadButtons.forEach((b) => b.disabled = input.disabled);
    }
  }

  const game = new BuckshotGame();
  window.buckshotGame = game;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const command = input.value;
    input.value = "";
    game.submit(command);
  });

  keypad.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const key = button.dataset.key;
    if (key === "enter") form.requestSubmit();
    else if (key === "clear") input.value = "";
    else if (key === "backspace") input.value = input.value.slice(0, -1);
    else input.value += key;
  });

  const media = window.matchMedia("(max-width: 640px), (pointer: coarse)");
  input.readOnly = media.matches;
  media.addEventListener("change", () => {
    input.readOnly = media.matches;
    if (input.readOnly && document.activeElement === input) input.blur();
  });
})();
