"use strict";

const crypto = require("node:crypto");

const DEFAULT_BALANCE = 1000;
const MIN_STAKE = 10;
const MAX_STAKE = 1000;

const LOCK_WAGER = `
  local existing = redis.call("GET", KEYS[3])
  if existing then
    local wager = cjson.decode(existing)
    if wager.status == "locked" or wager.status == "settled" then return {"ok", existing} end
    return {"error", "This wager has already been processed."}
  end
  local firstRaw = redis.call("GET", KEYS[1])
  local secondRaw = redis.call("GET", KEYS[2])
  if not firstRaw or not secondRaw then return {"error", "A player wallet could not be found."} end
  local first = cjson.decode(firstRaw)
  local second = cjson.decode(secondRaw)
  local stake = tonumber(ARGV[1])
  if first.id == second.id then return {"error", "Players cannot wager against themselves."} end
  if first.balance < stake or second.balance < stake then return {"error", "One or both players do not have enough available credits."} end
  first.balance = first.balance - stake
  first.locked = (first.locked or 0) + stake
  second.balance = second.balance - stake
  second.locked = (second.locked or 0) + stake
  local wager = cjson.decode(ARGV[2])
  redis.call("SET", KEYS[1], cjson.encode(first))
  redis.call("SET", KEYS[2], cjson.encode(second))
  redis.call("SET", KEYS[3], cjson.encode(wager))
  redis.call("RPUSH", KEYS[4], cjson.encode({type="stake_locked", wagerId=wager.id, amount=stake, at=tonumber(ARGV[3])}))
  return {"ok", cjson.encode(wager)}
`;

const SETTLE_WAGER = `
  local raw = redis.call("GET", KEYS[3])
  if not raw then return {"error", "Wager not found."} end
  local wager = cjson.decode(raw)
  if wager.status == "settled" then return {"ok", raw} end
  if wager.status ~= "locked" then return {"error", "Wager is not locked."} end
  local firstRaw = redis.call("GET", KEYS[1])
  local secondRaw = redis.call("GET", KEYS[2])
  if not firstRaw or not secondRaw then return {"error", "A player wallet could not be found."} end
  local first = cjson.decode(firstRaw)
  local second = cjson.decode(secondRaw)
  local winner = wager.hostPlayerId == ARGV[1] and first or second
  local loser = wager.hostPlayerId == ARGV[1] and second or first
  if winner.id ~= ARGV[1] and loser.id ~= ARGV[1] then return {"error", "Winner is not part of this wager."} end
  winner.locked = math.max(0, (winner.locked or 0) - wager.stake)
  loser.locked = math.max(0, (loser.locked or 0) - wager.stake)
  winner.balance = winner.balance + (wager.stake * 2)
  wager.status = "settled"
  wager.winnerPlayerId = ARGV[1]
  wager.settledAt = tonumber(ARGV[2])
  wager.pot = wager.stake * 2
  redis.call("SET", KEYS[1], cjson.encode(first))
  redis.call("SET", KEYS[2], cjson.encode(second))
  redis.call("SET", KEYS[3], cjson.encode(wager))
  redis.call("RPUSH", KEYS[4], cjson.encode({type="payout", wagerId=wager.id, winnerPlayerId=ARGV[1], amount=wager.pot, at=tonumber(ARGV[2])}))
  return {"ok", cjson.encode(wager)}
`;

const REFUND_WAGER = `
  local raw = redis.call("GET", KEYS[3])
  if not raw then return {"error", "Wager not found."} end
  local wager = cjson.decode(raw)
  if wager.status == "refunded" then return {"ok", raw} end
  if wager.status ~= "locked" then return {"error", "Wager is not locked."} end
  local firstRaw = redis.call("GET", KEYS[1])
  local secondRaw = redis.call("GET", KEYS[2])
  if not firstRaw or not secondRaw then return {"error", "A player wallet could not be found."} end
  local first = cjson.decode(firstRaw)
  local second = cjson.decode(secondRaw)
  first.locked = math.max(0, (first.locked or 0) - wager.stake)
  second.locked = math.max(0, (second.locked or 0) - wager.stake)
  first.balance = first.balance + wager.stake
  second.balance = second.balance + wager.stake
  wager.status = "refunded"
  wager.refundedAt = tonumber(ARGV[1])
  redis.call("SET", KEYS[1], cjson.encode(first))
  redis.call("SET", KEYS[2], cjson.encode(second))
  redis.call("SET", KEYS[3], cjson.encode(wager))
  redis.call("RPUSH", KEYS[4], cjson.encode({type="refund", wagerId=wager.id, amount=wager.stake, at=tonumber(ARGV[1])}))
  return {"ok", cjson.encode(wager)}
`;

class MemoryWalletManager {
  constructor({ startingBalance = DEFAULT_BALANCE } = {}) {
    this.startingBalance = startingBalance;
    this.accounts = new Map();
    this.wagers = new Map();
    this.ledger = [];
  }
  async register({ token, username }) {
    let account = token ? this.accounts.get(token) : null;
    if (token && !account) throw new Error("This player identity is not recognized. Clear the saved multiplayer identity and register again.");
    if (!account) {
      token = crypto.randomBytes(32).toString("hex");
      account = { id: crypto.randomUUID(), username, balance: this.startingBalance, locked: 0 };
      this.accounts.set(token, account);
    } else {
      account.username = username;
    }
    return { token, account: { ...account } };
  }
  async getAccount(token) {
    const account = this.accounts.get(token);
    return account ? { ...account } : null;
  }
  async lockWager(wager) {
    const existing = this.wagers.get(wager.id);
    if (existing) return existing.status === "locked" || existing.status === "settled" ? { ...existing } : null;
    const first = [...this.accounts.values()].find((account) => account.id === wager.hostPlayerId);
    const second = [...this.accounts.values()].find((account) => account.id === wager.guestPlayerId);
    if (!first || !second) throw new Error("A player wallet could not be found.");
    if (first.id === second.id) throw new Error("Players cannot wager against themselves.");
    if (first.balance < wager.stake || second.balance < wager.stake) throw new Error("One or both players do not have enough available credits.");
    first.balance -= wager.stake; first.locked += wager.stake;
    second.balance -= wager.stake; second.locked += wager.stake;
    const locked = { ...wager, status: "locked", lockedAt: Date.now() };
    this.wagers.set(wager.id, locked);
    this.ledger.push({ type: "stake_locked", wagerId: wager.id, amount: wager.stake, at: Date.now() });
    return { ...locked };
  }
  async settleWager(wagerId, winnerPlayerId) {
    const wager = this.wagers.get(wagerId);
    if (!wager) throw new Error("Wager not found.");
    if (wager.status === "settled") return { ...wager };
    if (wager.status !== "locked") throw new Error("Wager is not locked.");
    const winner = [...this.accounts.values()].find((account) => account.id === winnerPlayerId);
    const host = [...this.accounts.values()].find((account) => account.id === wager.hostPlayerId);
    const guest = [...this.accounts.values()].find((account) => account.id === wager.guestPlayerId);
    if (!winner || !host || !guest || (winner.id !== host.id && winner.id !== guest.id)) throw new Error("Winner is not part of this wager.");
    host.locked -= wager.stake; guest.locked -= wager.stake;
    winner.balance += wager.stake * 2;
    Object.assign(wager, { status: "settled", winnerPlayerId, settledAt: Date.now(), pot: wager.stake * 2 });
    this.ledger.push({ type: "payout", wagerId, winnerPlayerId, amount: wager.stake * 2, at: Date.now() });
    return { ...wager };
  }
  async refundWager(wagerId) {
    const wager = this.wagers.get(wagerId);
    if (!wager) throw new Error("Wager not found.");
    if (wager.status === "refunded") return { ...wager };
    if (wager.status !== "locked") throw new Error("Wager is not locked.");
    const host = [...this.accounts.values()].find((account) => account.id === wager.hostPlayerId);
    const guest = [...this.accounts.values()].find((account) => account.id === wager.guestPlayerId);
    if (!host || !guest) throw new Error("A player wallet could not be found.");
    host.locked -= wager.stake; guest.locked -= wager.stake;
    host.balance += wager.stake; guest.balance += wager.stake;
    Object.assign(wager, { status: "refunded", refundedAt: Date.now() });
    this.ledger.push({ type: "refund", wagerId, amount: wager.stake, at: Date.now() });
    return { ...wager };
  }
}

class RedisWalletManager {
  constructor(redis, { keyPrefix = "buckshot:wallet:" } = {}) {
    if (!redis || typeof redis.eval !== "function") throw new TypeError("A connected Redis client is required.");
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }
  accountKey(token) { return this.keyPrefix + "account:" + token; }
  wagerKey(id) { return this.keyPrefix + "wager:" + id; }
  ledgerKey() { return this.keyPrefix + "ledger"; }
  async register({ token, username }) {
    if (token) {
      const raw = await this.redis.get(this.accountKey(token));
      if (!raw) throw new Error("This player identity is not recognized. Clear the saved multiplayer identity and register again.");
      const account = JSON.parse(raw);
      account.username = username;
      await this.redis.set(this.accountKey(token), JSON.stringify(account));
      return { token, account };
    }
    const nextToken = crypto.randomBytes(32).toString("hex");
    const account = { id: crypto.randomUUID(), username, balance: DEFAULT_BALANCE, locked: 0 };
    const saved = await this.redis.set(this.accountKey(nextToken), JSON.stringify(account), "NX");
    if (!saved) return this.register({ username });
    return { token: nextToken, account };
  }
  async getAccount(token) {
    const raw = await this.redis.get(this.accountKey(token));
    return raw ? JSON.parse(raw) : null;
  }
  async lockWager(wager) {
    const result = await this.redis.eval(LOCK_WAGER, 4,
      this.accountKey(wager.hostToken), this.accountKey(wager.guestToken), this.wagerKey(wager.id), this.ledgerKey(),
      wager.stake, JSON.stringify({ ...wager, status: "locked", lockedAt: Date.now() }), Date.now());
    if (result[0] !== "ok") throw new Error(result[1]);
    return JSON.parse(result[1]);
  }
  async settleWager(wagerId, winnerPlayerId) {
    const raw = await this.redis.get(this.wagerKey(wagerId));
    if (!raw) throw new Error("Wager not found.");
    const wager = JSON.parse(raw);
    const result = await this.redis.eval(SETTLE_WAGER, 4,
      this.accountKey(wager.hostToken), this.accountKey(wager.guestToken), this.wagerKey(wagerId), this.ledgerKey(),
      winnerPlayerId, Date.now());
    if (result[0] !== "ok") throw new Error(result[1]);
    return JSON.parse(result[1]);
  }
  async refundWager(wagerId) {
    const raw = await this.redis.get(this.wagerKey(wagerId));
    if (!raw) throw new Error("Wager not found.");
    const wager = JSON.parse(raw);
    const result = await this.redis.eval(REFUND_WAGER, 4,
      this.accountKey(wager.hostToken), this.accountKey(wager.guestToken), this.wagerKey(wagerId), this.ledgerKey(), Date.now());
    if (result[0] !== "ok") throw new Error(result[1]);
    return JSON.parse(result[1]);
  }
}

module.exports = {
  DEFAULT_BALANCE, MIN_STAKE, MAX_STAKE,
  MemoryWalletManager, RedisWalletManager
};
