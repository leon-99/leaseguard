# Leaseguard

Production-grade distributed locking for Node.js. Leaseguard helps multiple servers, containers, workers, cron processes, and queue consumers coordinate access to shared work safely.

```ts
import { lock } from "leaseguard";

lock.setup(process.env.REDIS_URL);
```

```ts
import { lock } from "leaseguard";

await lock.run("task:123", async (ctx) => {
  ctx.throwIfLockLost();
  await runTask(123);
});
```

## Features

- Atomic acquisition with `SET PX NX`
- Owner-token protected renewal and release
- Automatic renewal for long-running tasks
- Lock-loss detection through the task context
- Retries, backoff, and optional jitter
- Timeout protection with abort signaling
- Lifecycle hooks for logging and monitoring
- One-line Redis setup for application startup

## Installation

```sh
npm install leaseguard
```

Leaseguard includes its Redis client dependency for the primary API.

## App Startup

Configure Leaseguard once when your application starts, for example in `app.ts`, `app.js`, `index.ts`, or `server.ts`:

```ts
// app.ts
import { lock } from "leaseguard";

lock.setup(process.env.REDIS_URL, {
  keyPrefix: "my-service:locks:",
  defaultTtlMs: 30_000,
  defaultRenewIntervalMs: 10_000,
  defaultRetries: 3,
  defaultRetryDelayMs: 500
});
```

Then import and use `lock.run` anywhere else in your app. Do not call `setup` inside feature modules, route handlers, jobs, or shared services.

### Run a Protected Task

```ts
// cleanup-job.ts
import { lock } from "leaseguard";

await lock.run("cleanup-job", async () => {
  await runCleanup();
});
```

If another process owns the lock, `run` skips by default and returns `undefined`.

### Retry When Locked

```ts
import { lock } from "leaseguard";

await lock.run(
  "data-sync",
  {
    retries: 5,
    retryDelayMs: 1_000,
    retryJitterMs: 250
  },
  async () => {
    await syncData();
  }
);
```

### Throw Instead of Skip

```ts
import { lock } from "leaseguard";

await lock.run(
  "resource-update",
  { onLockUnavailable: "throw" },
  async () => {
    await updateResource();
  }
);
```

### Detect Lock Loss

The renewal watchdog marks the context as lost if Redis cannot renew ownership or another owner takes over after expiry. Check inside long loops before doing the next unit of work.

```ts
import { lock } from "leaseguard";

await lock.run("batch-job", async (ctx) => {
  for (const task of tasks) {
    ctx.throwIfLockLost();
    await processTask(task);
  }
});
```

For a live Redis ownership check:

```ts
const stillOwner = await ctx.checkOwnership();
```

### Timeout Protection

```ts
import { lock } from "leaseguard";

await lock.run(
  "long-running-job",
  { timeoutMs: 300_000 },
  async (ctx) => {
    await runLongTask({ signal: ctx.signal });
  }
);
```

JavaScript cannot forcibly stop arbitrary async work. Leaseguard aborts the context signal and rejects with `LockTimeoutError`; cooperative task code should pass `ctx.signal` into cancellable operations.

### Lifecycle Hooks

```ts
import { lock } from "leaseguard";

// Put hooks in app startup, next to lock.setup.
lock.setup(process.env.REDIS_URL, {
  onAcquired: ({ lockName }) => logger.info({ lockName }, "lock acquired"),
  onReleased: ({ lockName }) => logger.info({ lockName }, "lock released"),
  onRenewFailed: ({ lockName, error }) => logger.error({ lockName, error }, "lock renewal failed"),
  onSkipped: ({ lockName }) => logger.info({ lockName }, "lock skipped"),
  onError: ({ lockName, error }) => logger.error({ lockName, error }, "lock task failed")
});
```

Leaseguard also exports the built-in defaults if you want to base your configuration on them:

```ts
import { LEASEGUARD_DEFAULTS, lock } from "leaseguard";

lock.setup(process.env.REDIS_URL, {
  defaultTtlMs: LEASEGUARD_DEFAULTS.ttlMs
});
```

Hooks can also be passed per `run` call.

## Configuration

```ts
import { lock } from "leaseguard";

lock.setup(process.env.REDIS_URL, {
  keyPrefix: "my-service:locks:",
  defaultTtlMs: 30_000,
  defaultRenewIntervalMs: 10_000,
  defaultRetries: 0,
  defaultRetryDelayMs: 250,
  defaultRetryJitterMs: 0,
  defaultOnLockUnavailable: "skip",
  throwOnLockLoss: true,
  ownerId: "api-1"
});
```

You can also pass Redis client options:

```ts
import { lock } from "leaseguard";

lock.setup(process.env.REDIS_URL, {
  redis: {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true
  }
});
```

## Safety Model

Each lock value is a unique owner token in the form:

```text
hostname:pid-1234:uuid
```

Renewal and release are Lua-scripted so Redis verifies ownership and mutates the key atomically. This prevents a process from renewing or deleting a lock that now belongs to another process.

## Build

```sh
npm run build
```
