import assert from "node:assert/strict";
import { test } from "node:test";
import { LockAcquisitionError, LockTimeoutError } from "../dist/errors.js";
import { Leaseguard } from "../dist/leaseguard.js";

class MemoryLockStore {
  locks = new Map();
  acquireCalls = 0;
  renewCalls = 0;
  releaseCalls = 0;

  async acquire(key, token) {
    this.acquireCalls += 1;
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.set(key, token);
    return true;
  }

  async renew(key, token) {
    this.renewCalls += 1;
    return this.locks.get(key) === token;
  }

  async release(key, token) {
    this.releaseCalls += 1;
    if (this.locks.get(key) !== token) {
      return false;
    }
    this.locks.delete(key);
    return true;
  }

  async isOwner(key, token) {
    return this.locks.get(key) === token;
  }
}

test("run acquires, executes, and releases the lock", async () => {
  const store = new MemoryLockStore();
  const events = [];
  const leaseguard = new Leaseguard({
    store,
    ownerId: "test-owner",
    keyPrefix: "test:",
    onAcquired: ({ lockName, key }) => events.push(["acquired", lockName, key]),
    onReleased: ({ lockName, key }) => events.push(["released", lockName, key])
  });

  const result = await leaseguard.run("daily-report", async (ctx) => {
    assert.equal(ctx.lockName, "daily-report");
    assert.equal(ctx.key, "test:daily-report");
    assert.match(ctx.token, /^test-owner:/);
    assert.equal(await ctx.checkOwnership(), true);
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(store.locks.size, 0);
  assert.deepEqual(events, [
    ["acquired", "daily-report", "test:daily-report"],
    ["released", "daily-report", "test:daily-report"]
  ]);
});

test("run skips by default when the lock is unavailable", async () => {
  const store = new MemoryLockStore();
  store.locks.set("leaseguard:job", "existing-owner");

  const skipped = [];
  const leaseguard = new Leaseguard({
    store,
    onSkipped: ({ lockName, key, attempt }) => skipped.push({ lockName, key, attempt })
  });

  const result = await leaseguard.run("job", () => "should not run");

  assert.equal(result, undefined);
  assert.equal(store.acquireCalls, 1);
  assert.deepEqual(skipped, [{ lockName: "job", key: "leaseguard:job", attempt: 1 }]);
});

test("run can throw when the lock is unavailable", async () => {
  const store = new MemoryLockStore();
  store.locks.set("leaseguard:job", "existing-owner");
  const leaseguard = new Leaseguard({ store });

  await assert.rejects(
    () => leaseguard.run("job", { onLockUnavailable: "throw" }, () => "should not run"),
    LockAcquisitionError
  );
});

test("acquire retries before succeeding", async () => {
  const store = new MemoryLockStore();
  store.locks.set("leaseguard:job", "existing-owner");
  const leaseguard = new Leaseguard({ store });

  const releaseExistingOwner = setTimeout(() => {
    store.locks.delete("leaseguard:job");
  }, 5);

  const handle = await leaseguard.acquire("job", {
    retries: 2,
    retryDelayMs: 10
  });

  clearTimeout(releaseExistingOwner);
  assert.ok(handle);
  assert.equal(store.acquireCalls, 2);
  assert.equal(await handle.release(), true);
});

test("timeout aborts the task context and releases the lock", async () => {
  const store = new MemoryLockStore();
  const leaseguard = new Leaseguard({ store });
  let observedAbort = false;

  await assert.rejects(
    () =>
      leaseguard.run(
        "slow-job",
        { timeoutMs: 10 },
        async (ctx) => {
          await new Promise((resolve) => {
            ctx.signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true }
            );
          });
        }
      ),
    LockTimeoutError
  );

  assert.equal(observedAbort, true);
  assert.equal(store.locks.size, 0);
  assert.equal(store.releaseCalls, 1);
});
