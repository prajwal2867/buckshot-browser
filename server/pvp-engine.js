"use strict";

const BASE_ITEMS = [
  "Magnifying Glass", "Handcuffs", "Beer", "Cigarette Pack", "Hand Saw"
];
const EXTRA_ITEMS = ["Adrenaline", "Burner Phone", "Inverter", "Expired Medicine"];
const ALL_ITEMS = [...BASE_ITEMS, ...EXTRA_ITEMS];
const MAX_INVENTORY = 8;

function randomInt(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}
function pick(items, random = Math.random) {
  return items[Math.floor(random() * items.length)];
}
function shuffle(items, random = Math.random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function addEvent(state, message, privateTo = null) {
  state.events.push({ message, privateTo });
  if (state.events.length > 30) state.events.shift();
}
function playerById(state, id) {
  return state.players.find((player) => player.id === id) || null;
}
function otherPlayer(state, player) {
  return state.players.find((candidate) => candidate.id !== player.id);
}
function entityKnowledge(state, player) {
  const known = state.knownShell[player.id];
  if (known) return known;
  const future = state.futureKnowledge[player.id] || {};
  if (future[0]) return future[0];
  let live = state.liveRemaining;
  let blank = state.blankRemaining;
  for (const [position, shell] of Object.entries(future)) {
    if (Number(position) <= 0) continue;
    if (shell === "live") live--;
    else blank--;
  }
  if (live === 0) return "blank";
  if (blank === 0) return "live";
  return null;
}
function shiftKnowledge(state) {
  for (const player of state.players) {
    const shifted = {};
    for (const [position, shell] of Object.entries(state.futureKnowledge[player.id] || {})) {
      const next = Number(position) - 1;
      if (next >= 0) shifted[next] = shell;
    }
    state.futureKnowledge[player.id] = shifted;
    delete state.knownShell[player.id];
  }
}
function drawShell(state) {
  const shell = state.chamber.shift();
  if (!shell) return null;
  if (shell === "live") state.liveRemaining--;
  else state.blankRemaining--;
  shiftKnowledge(state);
  return shell;
}
function distributeItems(state, random) {
  for (const player of state.players) {
    const count = randomInt(1, 5, random);
    for (let i = 0; i < count && player.inventory.length < MAX_INVENTORY; i++) {
      player.inventory.push(pick(ALL_ITEMS, random));
    }
  }
}
function reload(state, random = Math.random) {
  const total = randomInt(2, 8, random);
  let live = Math.floor(total / 2);
  let blank = Math.floor(total / 2);
  if (total % 2) {
    if (random() < 0.5) live++;
    else blank++;
  }
  state.chamber = shuffle([
    ...Array(live).fill("live"),
    ...Array(blank).fill("blank")
  ], random);
  state.liveRemaining = live;
  state.blankRemaining = blank;
  state.sawedOff = false;
  state.knownShell = {};
  state.futureKnowledge = Object.fromEntries(state.players.map((p) => [p.id, {}]));
  for (const player of state.players) player.handcuffed = false;
  state.reloadNumber++;
  distributeItems(state, random);
  addEvent(state, "A fresh magazine is loaded.");
}
function createGame(host, guest, random = Math.random) {
  const players = [
    { id: host.id, username: host.username, health: 4, maxHealth: 4, inventory: [], handcuffed: false },
    { id: guest.id, username: guest.username, health: 4, maxHealth: 4, inventory: [], handcuffed: false }
  ];
  const first = random() < 0.5 ? players[0] : players[1];
  const state = {
    status: "playing",
    players,
    turnPlayerId: first.id,
    chamber: [],
    liveRemaining: 0,
    blankRemaining: 0,
    reloadNumber: 0,
    sawedOff: false,
    knownShell: {},
    futureKnowledge: Object.fromEntries(players.map((p) => [p.id, {}])),
    pendingSteal: null,
    winnerId: null,
    events: [],
    createdAt: Date.now()
  };
  addEvent(state, first.username + " gets the first turn.");
  reload(state, random);
  return state;
}
function passTurn(state, player) {
  let next = otherPlayer(state, player);
  if (next.handcuffed) {
    next.handcuffed = false;
    addEvent(state, next.username + " loses a turn because of the handcuffs.");
    next = player;
  }
  state.turnPlayerId = next.id;
}
function finishIfDead(state) {
  const dead = state.players.find((player) => player.health <= 0);
  if (!dead) return false;
  state.status = "finished";
  state.winnerId = otherPlayer(state, dead).id;
  state.pendingSteal = null;
  addEvent(state, dead.username + " is out of health. " + playerById(state, state.winnerId).username + " wins.");
  return true;
}
function applyDamage(state, target, amount) {
  target.health = Math.max(0, target.health - amount);
}
function validItem(state, player, item) {
  const other = otherPlayer(state, player);
  if (["Magnifying Glass", "Beer", "Inverter", "Burner Phone"].includes(item) && !state.chamber.length) return false;
  if (item === "Handcuffs" && other.handcuffed) return false;
  if (item === "Hand Saw" && state.sawedOff) return false;
  if (item === "Cigarette Pack" && player.health >= player.maxHealth) return false;
  if (item === "Burner Phone" && state.chamber.length < 2) return false;
  if (item === "Adrenaline") {
    return other.inventory.some((candidate) => candidate !== "Adrenaline" && validItem(state, other, candidate));
  }
  return ALL_ITEMS.includes(item);
}
function useItemEffect(state, player, item, random = Math.random) {
  const other = otherPlayer(state, player);
  switch (item) {
    case "Magnifying Glass": {
      const shell = entityKnowledge(state, player) || state.chamber[0];
      state.knownShell[player.id] = shell;
      addEvent(state, player.username + " checks the current shell.", player.id);
      return true;
    }
    case "Handcuffs":
      other.handcuffed = true;
      addEvent(state, other.username + " is handcuffed and will miss their next turn.");
      return true;
    case "Beer": {
      const shell = drawShell(state);
      state.sawedOff = false;
      addEvent(state, player.username + " ejects a shell with Beer.");
      if (!state.chamber.length) reload(state, random);
      return Boolean(shell);
    }
    case "Cigarette Pack":
      player.health = Math.min(player.maxHealth, player.health + 1);
      addEvent(state, player.username + " restores 1 health.");
      return true;
    case "Hand Saw":
      state.sawedOff = true;
      addEvent(state, player.username + " prepares the Hand Saw. The next live shot deals 2 damage.");
      return true;
    case "Inverter": {
      const flipped = state.chamber[0] === "live" ? "blank" : "live";
      state.chamber[0] = flipped;
      if (flipped === "live") { state.liveRemaining++; state.blankRemaining--; }
      else { state.liveRemaining--; state.blankRemaining++; }
      for (const participant of state.players) {
        if (state.knownShell[participant.id]) state.knownShell[participant.id] = flipped;
        const future = state.futureKnowledge[participant.id];
        if (future && future[0]) future[0] = flipped;
      }
      state.knownShell[player.id] = flipped;
      addEvent(state, player.username + " uses the Inverter.");
      return true;
    }
    case "Burner Phone": {
      const future = state.futureKnowledge[player.id] || {};
      const positions = state.chamber.map((_, i) => i).filter((i) => i > 0 && !future[i]);
      if (!positions.length) return false;
      const index = positions[0];
      future[index] = state.chamber[index];
      addEvent(state, player.username + " checks a future shell with the Burner Phone.", player.id);
      return true;
    }
    case "Expired Medicine":
      if (random() < 0.5) {
        const healed = Math.min(2, player.maxHealth - player.health);
        player.health += healed;
        addEvent(state, player.username + "'s medicine works: +" + healed + " health.");
      } else {
        applyDamage(state, player, 1);
        addEvent(state, player.username + "'s medicine backfires: -1 health.");
      }
      return true;
    default:
      return false;
  }
}
function performAction(state, playerId, action, random = Math.random) {
  if (!state || state.status !== "playing") return { ok: false, error: "This match is not active." };
  const player = playerById(state, playerId);
  if (!player) return { ok: false, error: "You are not a player in this match." };
  if (state.turnPlayerId !== playerId) return { ok: false, error: "It is not your turn." };
  if (!action || typeof action !== "object") return { ok: false, error: "Invalid action." };

  if (state.pendingSteal) {
    if (state.pendingSteal.playerId !== playerId || action.type !== "steal" ||
        !Number.isInteger(action.itemIndex)) return { ok: false, error: "Choose an item to steal first." };
    const candidates = state.pendingSteal.candidates;
    const item = candidates[action.itemIndex];
    const victim = otherPlayer(state, player);
    const victimIndex = victim.inventory.indexOf(item);
    if (!item || victimIndex < 0 || !validItem(state, player, item)) return { ok: false, error: "That item can no longer be stolen." };
    victim.inventory.splice(victimIndex, 1);
    state.pendingSteal = null;
    if (!useItemEffect(state, player, item, random)) {
      victim.inventory.push(item);
      return { ok: false, error: "That item cannot be used right now." };
    }
    const adrenalineIndex = player.inventory.indexOf("Adrenaline");
    if (adrenalineIndex >= 0) player.inventory.splice(adrenalineIndex, 1);
    addEvent(state, player.username + " steals and uses " + item + ".");
    finishIfDead(state);
    return { ok: true };
  }

  if (action.type === "shoot") {
    if (action.target !== "self" && action.target !== "opponent") return { ok: false, error: "Choose yourself or your opponent." };
    if (!state.chamber.length) reload(state, random);
    const shell = drawShell(state);
    const damage = state.sawedOff ? 2 : 1;
    state.sawedOff = false;
    const target = action.target === "self" ? player : otherPlayer(state, player);
    if (shell === "live") {
      applyDamage(state, target, damage);
      addEvent(state, player.username + " fires a LIVE shell for " + damage + " damage.");
      passTurn(state, player);
    } else {
      addEvent(state, player.username + " fires a BLANK shell.");
      if (target !== player) passTurn(state, player);
      else addEvent(state, player.username + " keeps the turn.");
    }
    if (!finishIfDead(state) && !state.chamber.length) reload(state, random);
    return { ok: true };
  }

  if (action.type === "item") {
    if (!Number.isInteger(action.itemIndex) || action.itemIndex < 0 || action.itemIndex >= player.inventory.length) {
      return { ok: false, error: "Choose a valid inventory item." };
    }
    const item = player.inventory[action.itemIndex];
    if (!validItem(state, player, item)) return { ok: false, error: "That item cannot be used right now." };
    if (item === "Adrenaline") {
      const victim = otherPlayer(state, player);
      const candidates = victim.inventory.filter((candidate) => candidate !== "Adrenaline" && validItem(state, player, candidate));
      if (!candidates.length) return { ok: false, error: "Your opponent has no usable item to steal." };
      state.pendingSteal = { playerId, candidates };
      return { ok: true, stealOptions: candidates };
    }
    if (!useItemEffect(state, player, item, random)) return { ok: false, error: "That item cannot be used right now." };
    player.inventory.splice(action.itemIndex, 1);
    finishIfDead(state);
    if (!state.chamber.length && state.status === "playing") reload(state, random);
    return { ok: true };
  }
  return { ok: false, error: "Unknown action." };
}
function getPlayerView(state, playerId) {
  const player = playerById(state, playerId);
  if (!player) return null;
  const events = state.events.filter((event) => !event.privateTo || event.privateTo === playerId).map((event) => event.message);
  const view = {
    status: state.status,
    players: state.players.map((p) => ({
      username: p.username,
      health: p.health,
      maxHealth: p.maxHealth,
      inventory: [...p.inventory],
      handcuffed: p.handcuffed
    })),
    yourTurn: state.turnPlayerId === playerId,
    turnUsername: playerById(state, state.turnPlayerId)?.username || null,
    magazine: { remaining: state.chamber.length, live: state.liveRemaining, blank: state.blankRemaining, reload: state.reloadNumber },
    sawedOff: state.sawedOff,
    knownCurrentShell: entityKnowledge(state, player),
    stealOptions: state.pendingSteal?.playerId === playerId ? [...state.pendingSteal.candidates] : [],
    winner: state.winnerId ? playerById(state, state.winnerId)?.username : null,
    events
  };
  return view;
}

module.exports = { createGame, performAction, getPlayerView, reload, validItem, ALL_ITEMS };
