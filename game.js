(() => {
  "use strict";

  const LEVEL_HEALTH = [2, 4, 4];
  const ITEMS_PER_LEVEL = [3, 4, 5];
  const DEALER_DELAY_MS = 10_000;
  const ITEM_PRIORITY = [
    "Magnifying Glass",
    "Adrenaline",
    "Handcuffs",
    "Hand Saw",
    "Burner Phone",
    "Inverter",
    "Cigarette Pack",
    "Beer",
    "Expired Medicine",
  ];

  const screen = document.querySelector("#screen");
  const form = document.querySelector("#command-form");
  const input = document.querySelector("#command-input");
  const promptLabel = document.querySelector("#prompt-label");
  const keypad = document.querySelector("#keypad");
  const keypadButtons = keypad.querySelectorAll("button");
  const usesOnScreenKeys = window.matchMedia("(max-width: 640px), (pointer: coarse)");
  input.readOnly = usesOnScreenKeys.matches;
  usesOnScreenKeys.addEventListener("change", () => {
    input.readOnly = usesOnScreenKeys.matches;
    if (input.readOnly && document.activeElement === input) input.blur();
  });

  class BuckshotGame {
    constructor() {
      this.level = 1;
      this.reloadNumber = 0;
      this.player = this.makeEntity("Player");
      this.dealer = this.makeEntity("Dealer");
      this.current = this.player;
      this.opponent = this.dealer;
      this.chamber = [];
      this.isSawedOff = false;
      this.results = [];
      this.events = [];
      this.mode = "start";
      this.gameOver = false;
      this.busy = false;
      this.render();
    }

    makeEntity(name) {
      return {
        name,
        health: 0,
        maxHealth: 0,
        inventory: [],
        isHandcuffed: false,
      };
    }

    start() {
      this.setLevelHealth();
      this.distributeItems();
      this.addEvent("Welcome to the room. Three levels. One way out.");
      this.reload();
      this.mode = "action";
      this.render();
    }

    setLevelHealth() {
      const health = LEVEL_HEALTH[this.level - 1];
      for (const entity of [this.player, this.dealer]) {
        entity.health = health;
        entity.maxHealth = health;
      }
    }

    distributeItems() {
      const count = ITEMS_PER_LEVEL[this.level - 1];
      for (const entity of [this.player, this.dealer]) {
        const available = [...ITEM_PRIORITY];
        entity.inventory = [];
        for (let i = 0; i < count; i += 1) {
          const weights = available.map((_, index) => ITEM_PRIORITY.length - ITEM_PRIORITY.indexOf(available[index]));
          const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
          let roll = Math.random() * totalWeight;
          let selectedIndex = 0;
          for (let j = 0; j < weights.length; j += 1) {
            roll -= weights[j];
            if (roll < 0) {
              selectedIndex = j;
              break;
            }
          }
          entity.inventory.push(available.splice(selectedIndex, 1)[0]);
        }
      }
    }

    reload() {
      this.reloadNumber += 1;
      const total = 2 + Math.floor(Math.random() * 7);
      let live = Math.floor(total / 2);
      let blank = Math.floor(total / 2);
      if (total % 2 === 1) {
        if (Math.random() < 0.5) live += 1;
        else blank += 1;
      }
      this.chamber = [...Array(live).fill("live"), ...Array(blank).fill("blank")];
      this.shuffle(this.chamber);
      this.isSawedOff = false;
      this.addEvent(`Level ${this.level}, reload ${this.reloadNumber}: ${total} shells (${live} live, ${blank} blank).`);
    }

    shuffle(values) {
      for (let i = values.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [values[i], values[j]] = [values[j], values[i]];
      }
    }

    addEvent(message) {
      this.events.push(message);
      if (this.events.length > 10) this.events.shift();
    }

    submit(rawCommand) {
      const command = rawCommand.trim();
      if (this.mode === "start") {
        this.start();
        return;
      }
      if (this.mode === "restart") {
        if (command.toLowerCase() === "r" || command === "") {
          window.location.reload();
        } else {
          this.addEvent("Enter R to play again.");
          this.render();
        }
        return;
      }
      if (this.mode === "item") {
        this.selectItem(command);
        return;
      }
      if (this.mode !== "action" || this.busy) return;
      if (command === "1") {
        this.fireAtOpponent();
      } else if (command === "2") {
        this.fireAtSelf();
      } else if (command === "3") {
        this.openInventory();
      } else {
        this.addEvent("Choose 1, 2, or 3.");
      }
      this.finishAction();
    }

    openInventory() {
      if (this.player.inventory.length === 0) {
        this.addEvent("Your pockets are empty.");
        return;
      }
      this.mode = "item";
      this.addEvent("Choose an item (enter 0 to go back):");
      this.player.inventory.forEach((item, index) => {
        this.addEvent(`${index + 1}. ${item}`);
      });
    }

    selectItem(command) {
      if (command === "0") {
        this.mode = "action";
      } else if (/^\d+$/.test(command)) {
        const item = this.player.inventory[Number(command) - 1];
        if (!item) {
          this.addEvent("Enter a listed item number, or 0 to go back.");
        } else {
          const result = this.useItem(this.player, item);
          if (result === "select") {
            this.render();
            return;
          }
          if (result) {
            this.addEvent(`${item} used.`);
            this.mode = "action";
            this.checkLevelEnd();
            if (this.gameOver) this.mode = "restart";
          }
        }
      } else {
        this.addEvent("Enter a listed item number, or 0 to go back.");
      }
      this.render();
    }

    finishAction() {
      if (this.gameOver) {
        this.mode = "restart";
        this.render();
        return;
      }
      if (this.mode === "action") this.checkLevelEnd();
      if (this.gameOver) {
        this.mode = "restart";
        this.render();
        return;
      }
      if (this.chamber.length === 0) this.reload();
      if (this.current === this.dealer) {
        this.runDealerTurn();
      } else {
        this.render();
      }
    }

    fireAtOpponent() {
      const shooter = this.current;
      const target = this.opponent;
      const shell = this.takeShell();
      const damage = this.damageForShot();
      if (shell === "live") {
        target.health = Math.max(0, target.health - damage);
        this.addEvent(`${shooter.name} fires at ${target.name}. The live shell deals ${damage} damage.`);
      } else {
        this.addEvent(`${shooter.name} fires a blank at ${target.name}.`);
      }
      this.switchTurn();
    }

    fireAtSelf() {
      const shooter = this.current;
      const shell = this.takeShell();
      const damage = this.damageForShot();
      if (shell === "live") {
        shooter.health = Math.max(0, shooter.health - damage);
        this.addEvent(`${shooter.name} fires at themselves. The live shell deals ${damage} damage.`);
        this.switchTurn();
      } else {
        this.addEvent(`${shooter.name} fires a blank at themselves.`);
        this.addEvent(`${shooter.name} keeps the turn.`);
      }
    }

    takeShell() {
      if (this.chamber.length === 0) this.reload();
      return this.chamber.shift();
    }

    damageForShot() {
      if (this.isSawedOff) {
        this.isSawedOff = false;
        return 2;
      }
      return 1;
    }

    switchTurn() {
      [this.current, this.opponent] = [this.opponent, this.current];
      if (this.current.isHandcuffed) {
        this.current.isHandcuffed = false;
        this.addEvent(`${this.current.name} skips their turn due to handcuffs.`);
        [this.current, this.opponent] = [this.opponent, this.current];
      }
    }

    useItem(owner, item) {
      const opponent = owner === this.player ? this.dealer : this.player;
      let used = true;
      switch (item) {
        case "Magnifying Glass":
          if (this.chamber.length === 0) this.reload();
          this.addEvent(`You peer into the chamber... It's a ${this.chamber[0].toUpperCase()} shell.`);
          break;
        case "Hand Saw":
          if (this.isSawedOff) {
            this.addEvent("The barrel is already sawed off.");
            used = false;
          } else {
            this.isSawedOff = true;
            this.addEvent("You saw off the barrel! The next shot will deal double damage.");
          }
          break;
        case "Handcuffs":
          if (opponent.isHandcuffed) {
            this.addEvent("They are already handcuffed for the next turn.");
            used = false;
          } else {
            opponent.isHandcuffed = true;
            this.addEvent(`${opponent.name} is cuffed! They will skip their next turn.`);
          }
          break;
        case "Cigarette Pack":
          if (owner.health >= owner.maxHealth) {
            this.addEvent("Health is already full.");
            used = false;
          } else {
            owner.health += 1;
            this.addEvent(`${owner.name} restored 1 health point (${owner.health}/${owner.maxHealth}).`);
          }
          break;
        case "Beer": {
          if (this.chamber.length === 0) this.reload();
          const ejected = this.chamber.shift();
          this.addEvent(`You rack the gun. A ${ejected.toUpperCase()} shell flies out.`);
          if (this.chamber.length === 0) this.reload();
          break;
        }
        case "Adrenaline":
          used = this.useAdrenaline(owner, opponent);
          break;
        case "Inverter":
          if (this.chamber.length === 0) this.reload();
          this.chamber[0] = this.chamber[0] === "live" ? "blank" : "live";
          this.addEvent("The Inverter flips the current shell's polarity.");
          break;
        case "Burner Phone":
          if (this.chamber.length <= 1) {
            this.addEvent("Too late to change the future. Only one shell remains.");
          } else {
            const index = 1 + Math.floor(Math.random() * (this.chamber.length - 1));
            this.addEvent(`A mysterious voice whispers: shell number ${index + 1} is ${this.chamber[index].toUpperCase()}.`);
          }
          break;
        case "Expired Medicine":
          if (Math.random() < 0.45) {
            const healed = Math.min(2, owner.maxHealth - owner.health);
            owner.health += healed;
            this.addEvent(`High risk paid off! Restored ${healed} health point(s).`);
          } else {
            owner.health = Math.max(0, owner.health - 1);
            this.addEvent("The medicine backfires. You lost 1 health.");
          }
          break;
        default:
          this.addEvent("That item is not available.");
          used = false;
      }
      if (used && (item !== "Adrenaline" || owner === this.dealer)) {
        const index = owner.inventory.indexOf(item);
        if (index !== -1) owner.inventory.splice(index, 1);
      }
      return used;
    }

    useAdrenaline(owner, opponent) {
      const stealable = opponent.inventory.filter((item) => item !== "Adrenaline");
      if (stealable.length === 0) {
        this.addEvent("Adrenaline rush, but the opponent has no items to steal!");
        return false;
      }

      let stolen;
      if (owner === this.player) {
        this.mode = "steal";
        this.stealableItems = stealable;
        this.addEvent("Choose an item to steal:");
        stealable.forEach((item, index) => this.addEvent(`${index + 1}. ${item}`));
        return "select";
      }
      stolen = stealable[Math.floor(Math.random() * stealable.length)];
      return this.stealAndUse(owner, opponent, stolen);
    }

    stealAndUse(owner, opponent, stolen) {
      const opponentIndex = opponent.inventory.indexOf(stolen);
      if (opponentIndex === -1) return false;
      opponent.inventory.splice(opponentIndex, 1);
      this.addEvent(`Stole ${stolen} and use it immediately.`);
      if (this.useItem(owner, stolen)) return true;
      opponent.inventory.push(stolen);
      return false;
    }

    handleSteal(command) {
      if (/^\d+$/.test(command)) {
        const item = this.stealableItems[Number(command) - 1];
        if (item) {
          const success = this.stealAndUse(this.player, this.dealer, item);
          if (success) {
            this.player.inventory.splice(this.player.inventory.indexOf("Adrenaline"), 1);
            this.addEvent("Adrenaline used.");
            this.mode = "action";
            this.checkLevelEnd();
          } else {
            this.mode = "action";
          }
        } else {
          this.addEvent("Enter a listed item number.");
        }
      } else {
        this.addEvent("Enter a listed item number.");
      }
      this.render();
    }

    checkLevelEnd() {
      if (this.player.health > 0 && this.dealer.health > 0) return;
      const winner = this.player.health <= 0 ? this.dealer : this.player;
      const result = `${winner.name} won level ${this.level}`;
      this.results.push(result);
      this.addEvent(result);

      if (this.level === LEVEL_HEALTH.length) {
        this.gameOver = true;
        this.addEvent(`${winner.name} wins.`);
        return;
      }

      this.level += 1;
      this.setLevelHealth();
      for (const entity of [this.player, this.dealer]) {
        entity.isHandcuffed = false;
        entity.inventory = [];
      }
      this.chamber = [];
      this.isSawedOff = false;
      this.current = this.player;
      this.opponent = this.dealer;
      this.distributeItems();
      this.addEvent(`Starting Level ${this.level}.`);
      this.reload();
    }

    runDealerTurn() {
      if (this.dealer.isHandcuffed) {
        this.dealer.isHandcuffed = false;
        this.addEvent("Dealer skips their turn due to handcuffs.");
        this.current = this.player;
        this.opponent = this.dealer;
        this.render();
        return;
      }
      this.busy = true;
      this.mode = "waiting";
      this.addEvent("Dealer is thinking...");
      this.render();
      window.setTimeout(() => {
        if (this.gameOver) return;
        this.mode = "action";
        this.dealerTurn();
        this.busy = false;
        this.checkLevelEnd();
        if (!this.gameOver && this.chamber.length === 0) this.reload();
        if (!this.gameOver && this.current === this.dealer) {
          this.runDealerTurn();
        } else {
          this.render();
        }
      }, DEALER_DELAY_MS);
    }

    dealerTurn() {
      if (this.dealer.isHandcuffed) {
        this.dealer.isHandcuffed = false;
        this.addEvent("Dealer skips their turn due to handcuffs.");
        this.current = this.player;
        this.opponent = this.dealer;
        return;
      }

      const item = this.chooseDealerItem();
      if (item) this.useItem(this.dealer, item);
      if (this.dealer.health <= 0 || this.player.health <= 0) return;

      const target = this.chamber[0] === "blank"
        ? "self"
        : this.chamber[0] === "live"
          ? "opponent"
          : (Math.random() < 0.5 ? "self" : "opponent");
      if (target === "self") {
        this.current = this.dealer;
        this.opponent = this.player;
        this.fireAtSelf();
      } else {
        this.current = this.dealer;
        this.opponent = this.player;
        this.fireAtOpponent();
      }
    }

    chooseDealerItem() {
      for (const item of this.dealer.inventory) {
        if (item === "Cigarette Pack" && this.dealer.health < this.dealer.maxHealth) return item;
        if (item === "Hand Saw" && this.chamber.includes("live")) return item;
        if (item === "Handcuffs" && !this.player.isHandcuffed) return item;
        if (item === "Magnifying Glass") return item;
        if (item === "Inverter") return item;
      }
      return null;
    }

    render() {
      if (this.mode === "start") {
        screen.innerHTML = [
          '<span class="title">BUCKSHOT ROULETTE</span>',
          "",
          "A terminal game of chance against the Dealer.",
          "Three levels. Nine items. One way out.",
          "",
          '<span class="separator">---</span>',
        ].join("\n");
        promptLabel.textContent = "Press Enter to begin:";
        input.disabled = false;
        if (!input.readOnly) input.focus();
        keypadButtons.forEach((button) => {
          button.disabled = input.disabled;
        });
        return;
      }

      const lines = [
        `<span class="title">==== Lev. ${this.level} / Rel. ${this.reloadNumber || 1} ====</span>`,
        "",
        `${this.chamber.length} SHELLS ( ${this.chamber.filter((shell) => shell === "live").length}L / ${this.chamber.filter((shell) => shell === "blank").length}B )`,
        "",
        `PLAYER LIVES:  ${this.player.health}`,
        `DEALER LIVES:  ${this.dealer.health}`,
        "",
        `PLAYER items [${this.player.inventory.length}] : ${this.player.inventory.join(", ") || "none"}`,
        `DEALER items [${this.dealer.inventory.length}] : ${this.dealer.inventory.join(", ") || "none"}`,
        "",
        ...this.results.map((result) => `> ${this.escape(result)}`),
      ];
      for (let i = this.results.length; i < 3; i += 1) lines.push(">");
      lines.push('<span class="separator">---</span>', "");

      if (!this.gameOver && this.mode !== "start" && this.mode !== "restart") {
        lines.push("1. Shoot the Dealer", "2. Shoot Yourself", "3. Use an item", "");
      }
      lines.push('<span class="separator">---</span>', "");
      if (!this.gameOver && this.mode !== "start" && this.mode !== "restart") {
        lines.push(`<span class="status">(${this.current === this.player ? "P" : "Dealer"}'s Turn)</span>`);
      }
      lines.push("", '<span class="title">RECENT EVENTS:</span>');
      for (const event of this.events.slice(-8)) lines.push(`<span class="event">&gt; ${this.escape(event)}</span>`);
      if (this.events.length === 0) lines.push('<span class="muted">&gt;</span>');
      lines.push("", '<span class="separator">---</span>');
      screen.innerHTML = lines.join("\n");
      screen.scrollTop = screen.scrollHeight;

      if (this.mode === "start") {
        promptLabel.textContent = "Press Enter to begin:";
        input.disabled = false;
      } else if (this.mode === "item") {
        promptLabel.textContent = "Item number:";
        input.disabled = false;
      } else if (this.mode === "steal") {
        promptLabel.textContent = "Steal item number:";
        input.disabled = false;
      } else if (this.mode === "restart") {
        promptLabel.textContent = "R to restart:";
        input.disabled = false;
      } else if (this.mode === "waiting") {
        promptLabel.textContent = "Dealer:";
        input.disabled = true;
      } else {
        promptLabel.textContent = "Select an action:";
        input.disabled = false;
      }
      if (!input.disabled && !input.readOnly) input.focus();
      keypadButtons.forEach((button) => {
        button.disabled = input.disabled;
      });
    }

    escape(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
  }

  const game = new BuckshotGame();
  window.buckshotGame = game;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const command = input.value;
    input.value = "";
    if (game.mode === "steal") game.handleSteal(command.trim());
    else game.submit(command);
  });

  keypad.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    const key = button.dataset.key;
    if (key === "enter") {
      form.requestSubmit();
    } else if (key === "clear") {
      input.value = "";
    } else if (key === "backspace") {
      input.value = input.value.slice(0, -1);
    } else {
      input.value += key;
    }
  });
})();
