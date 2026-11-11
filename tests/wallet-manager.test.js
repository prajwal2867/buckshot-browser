"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryWalletManager } = require("../server/wallet-manager");

test("new multiplayer identities receive an isolated virtual-credit wallet", async () => {
  const wallets = new MemoryWalletManager();
  const first = await wallets.register({ username: "PlayerOne" });
  const second = await wallets.register({ username: "PlayerTwo" });

  assert.equal(first.account.balance, 1000);
  assert.equal(first.account.locked, 0);
  assert.notEqual(first.account.id, second.account.id);

  const restored = await wallets.register({ token: first.token, username: "PlayerOne" });
  assert.equal(restored.account.id, first.account.id);
  assert.equal(restored.account.balance, 1000);
});

test("locks both stakes and pays the winner exactly once", async () => {
  const wallets = new MemoryWalletManager();
  const host = await wallets.register({ username: "HostPlayer" });
  const guest = await wallets.register({ username: "GuestPlayer" });
  const wager = {
    id: "wager-1",
    stake: 200,
    hostPlayerId: host.account.id,
    guestPlayerId: guest.account.id
  };

  const locked = await wallets.lockWager(wager);
  assert.equal(locked.status, "locked");
  assert.equal((await wallets.getAccount(host.token)).balance, 800);
  assert.equal((await wallets.getAccount(host.token)).locked, 200);
  assert.equal((await wallets.getAccount(guest.token)).balance, 800);

  const settled = await wallets.settleWager(wager.id, host.account.id);
  assert.equal(settled.status, "settled");
  assert.equal(settled.pot, 400);
  assert.equal((await wallets.getAccount(host.token)).balance, 1200);
  assert.equal((await wallets.getAccount(host.token)).locked, 0);
  assert.equal((await wallets.getAccount(guest.token)).balance, 800);
  assert.equal((await wallets.getAccount(guest.token)).locked, 0);

  await wallets.settleWager(wager.id, host.account.id);
  assert.equal((await wallets.getAccount(host.token)).balance, 1200);
  assert.equal(wallets.ledger.filter((entry) => entry.type === "payout").length, 1);
});

test("refund returns both stakes and is idempotent", async () => {
  const wallets = new MemoryWalletManager();
  const host = await wallets.register({ username: "HostPlayer" });
  const guest = await wallets.register({ username: "GuestPlayer" });
  await wallets.lockWager({
    id: "wager-refund",
    stake: 350,
    hostPlayerId: host.account.id,
    guestPlayerId: guest.account.id
  });

  await wallets.refundWager("wager-refund");
  await wallets.refundWager("wager-refund");
  assert.equal((await wallets.getAccount(host.token)).balance, 1000);
  assert.equal((await wallets.getAccount(guest.token)).balance, 1000);
  assert.equal((await wallets.getAccount(host.token)).locked, 0);
  assert.equal(wallets.ledger.filter((entry) => entry.type === "refund").length, 1);
});

test("rejects a wager if either player cannot afford the stake", async () => {
  const wallets = new MemoryWalletManager();
  const host = await wallets.register({ username: "HostPlayer" });
  const guest = await wallets.register({ username: "GuestPlayer" });
  await assert.rejects(
    () => wallets.lockWager({
      id: "wager-too-large",
      stake: 1001,
      hostPlayerId: host.account.id,
      guestPlayerId: guest.account.id
    }),
    /not have enough available credits/
  );
  assert.equal((await wallets.getAccount(host.token)).balance, 1000);
  assert.equal((await wallets.getAccount(guest.token)).balance, 1000);
});

const Redis = require("ioredis");
const { RedisWalletManager } = require("../server/wallet-manager");

const redisUrl = process.env.REDIS_URL;
const redisTest = (name, fn) => test(name, { skip: !redisUrl && "REDIS_URL is not configured" }, fn);

async function withRedisWallets(run) {
  const redis = new Redis(redisUrl);
  const prefix = `test-wallet:${Date.now()}:${require("node:crypto").randomUUID()}:`;
  const wallets = new RedisWalletManager(redis, { keyPrefix: prefix });
  try {
    await run({ redis, wallets, prefix });
  } finally {
    const keys = await redis.keys(prefix + "*");
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
}

redisTest("Redis wallets persist identities and atomically escrow and settle a wager once", async () => {
  await withRedisWallets(async ({ wallets }) => {
    const host = await wallets.register({ username: "HostPlayer" });
    const guest = await wallets.register({ username: "GuestPlayer" });
    const restored = await wallets.register({ token: host.token, username: "HostPlayer" });
    assert.equal(restored.account.id, host.account.id);

    const wager = {
      id: "redis-wager-settle",
      stake: 200,
      hostPlayerId: host.account.id,
      guestPlayerId: guest.account.id
    };
    const locked = await wallets.lockWager(wager);
    assert.equal(locked.status, "locked");
    assert.equal((await wallets.getAccount(host.token)).balance, 800);
    assert.equal((await wallets.getAccount(host.token)).locked, 200);
    assert.equal((await wallets.getAccount(guest.token)).balance, 800);

    const settled = await wallets.settleWager(wager.id, guest.account.id);
    assert.equal(settled.status, "settled");
    assert.equal(settled.pot, 400);
    assert.equal((await wallets.getAccount(host.token)).balance, 800);
    assert.equal((await wallets.getAccount(host.token)).locked, 0);
    assert.equal((await wallets.getAccount(guest.token)).balance, 1200);
    assert.equal((await wallets.getAccount(guest.token)).locked, 0);

    await wallets.settleWager(wager.id, guest.account.id);
    assert.equal((await wallets.getAccount(guest.token)).balance, 1200);
  });
});

redisTest("Redis wallet refunds locked stakes exactly once", async () => {
  await withRedisWallets(async ({ wallets }) => {
    const host = await wallets.register({ username: "HostPlayer" });
    const guest = await wallets.register({ username: "GuestPlayer" });
    await wallets.lockWager({
      id: "redis-wager-refund",
      stake: 350,
      hostPlayerId: host.account.id,
      guestPlayerId: guest.account.id
    });

    const refunded = await wallets.refundWager("redis-wager-refund");
    assert.equal(refunded.status, "refunded");
    await wallets.refundWager("redis-wager-refund");
    assert.equal((await wallets.getAccount(host.token)).balance, 1000);
    assert.equal((await wallets.getAccount(guest.token)).balance, 1000);
    assert.equal((await wallets.getAccount(host.token)).locked, 0);
    assert.equal((await wallets.getAccount(guest.token)).locked, 0);
  });
});

redisTest("Redis wallet rejects unaffordable wagers without changing either balance", async () => {
  await withRedisWallets(async ({ wallets }) => {
    const host = await wallets.register({ username: "HostPlayer" });
    const guest = await wallets.register({ username: "GuestPlayer" });
    await assert.rejects(
      () => wallets.lockWager({
        id: "redis-wager-too-large",
        stake: 1001,
        hostPlayerId: host.account.id,
        guestPlayerId: guest.account.id
      }),
      /not have enough available credits/
    );
    assert.equal((await wallets.getAccount(host.token)).balance, 1000);
    assert.equal((await wallets.getAccount(guest.token)).balance, 1000);
  });
});
