# Leaseguard Code Flow

This document explains how the project code works internally. It is not a user manual for the public API. File references point to the TypeScript source that implements each part of the flow.

## Module Map

```mermaid
flowchart TD
  index["src/index.ts<br/>public exports"]
  facade["src/facade.ts<br/>singleton Redis facade"]
  core["src/leaseguard.ts<br/>core lock orchestration"]
  types["src/types.ts<br/>interfaces and option contracts"]
  defaults["src/defaults.ts<br/>default option values"]
  token["src/token.ts<br/>owner id and lock token generation"]
  errors["src/errors.ts<br/>typed runtime errors"]
  redis["src/stores/redis.ts<br/>Redis-backed LockStore"]
  scripts["src/stores/redis-scripts.ts<br/>Lua ownership checks"]
  ioredis["ioredis<br/>Redis client"]
  redisServer["Redis server"]

  index --> facade
  index --> core
  index --> defaults
  index --> errors
  index --> types
  facade --> core
  facade --> redis
  facade --> ioredis
  core --> types
  core --> defaults
  core --> token
  core --> errors
  core --> redis
  redis --> scripts
  redis --> redisServer
```

## Responsibilities

`src/index.ts` is the public export surface. It exposes the singleton `lock`, defaults, error classes, and public types.

`src/facade.ts` owns the high-level Redis setup path. `LeaseguardFacade.setup()` creates an `ioredis` client, wraps it in `RedisLockStore`, creates one `Leaseguard` instance, and stores both the Redis client and core instance for later `lock.run()` calls.

`src/leaseguard.ts` is the core state machine. It normalizes options, acquires locks through a `LockStore`, creates the execution context, starts renewal, runs the task, handles timeout and abort signals, emits hooks, and releases the lock in `finally`.

`src/stores/redis.ts` adapts Redis to the `LockStore` interface. `acquire()` uses `SET key token PX ttl NX`. `renew()` and `release()` use Lua scripts so Redis checks ownership and mutates the key atomically.

`src/stores/redis-scripts.ts` holds the Lua scripts. Both scripts compare the stored token with the caller token before changing the key.

`src/types.ts` defines the contracts between the core and any storage implementation: `LockStore`, lifecycle hooks, options, `LockContext`, and `LockHandle`.

`src/token.ts` creates the process owner id and per-lock token. The owner id is stable for a `Leaseguard` instance, while every acquisition gets a fresh UUID token.

`src/errors.ts` defines typed failures used by the core flow.

## Setup Flow

The package has two construction paths:

1. The facade path, used by `lock.setup(redisUrl)`.
2. The direct constructor path, used by tests or custom stores: `new Leaseguard({ store })`.

```mermaid
sequenceDiagram
  participant App
  participant Facade as LeaseguardFacade
  participant RedisClient as ioredis Redis
  participant Store as RedisLockStore
  participant Core as Leaseguard

  App->>Facade: lock.setup(redisUrl, options)
  Facade->>Facade: validate redisUrl
  Facade->>RedisClient: new Redis(redisUrl, redisOptions)
  Facade->>Store: new RedisLockStore(redisLike, redisStoreOptions)
  Facade->>Core: createLeaseguard({ ...options, store })
  Core->>Core: ownerId = option or createOwnerId()
  Core->>Core: keyPrefix = option or LEASEGUARD_DEFAULTS.keyPrefix
  Facade-->>App: Leaseguard instance
```

`toRedisLike()` in `src/facade.ts` narrows the `ioredis` client to the small shape needed by `RedisLockStore`: `set`, `eval`, and `get`. This keeps the store implementation independent from the full Redis client type.

## Main `run()` Flow

`Leaseguard.run()` wraps task execution with lock acquisition, automatic renewal, timeout handling, hook emission, and release.

```mermaid
flowchart TD
  start["run(lockName, optionsOrTask, maybeTask)"]
  taskCheck{"Task function present?"}
  normalize["normalizeRunOptions()"]
  abortController["Create execution AbortController"]
  wireAbort["Forward caller signal to execution signal"]
  acquire["acquire(lockName, runOptions + signal)"]
  acquired{"Handle returned?"}
  startRenewal["startRenewal()"]
  runTask["Promise.resolve(task(context))"]
  timeout{"timeoutMs set?"}
  race["withTimeout(): race task against timer"]
  awaitResult["await task result"]
  lostCheck{"throwOnLockLoss and context lost?"}
  returnResult["return task result"]
  emitError["emitError() and rethrow"]
  cleanup["finally: stop renewal, detach abort listener"]
  release["handle.release()"]
  releaseOk{"Release succeeds?"}
  releaseError["emitError() and throw release error"]
  skipped["return undefined"]
  typeError["throw TypeError"]
  lostError["throw LockLostError"]

  start --> taskCheck
  taskCheck -- no --> typeError
  taskCheck -- yes --> normalize
  normalize --> abortController
  abortController --> wireAbort
  wireAbort --> acquire
  acquire --> acquired
  acquired -- no --> skipped
  acquired -- yes --> startRenewal
  startRenewal --> runTask
  runTask --> timeout
  timeout -- yes --> race
  timeout -- no --> awaitResult
  race --> awaitResult
  awaitResult --> lostCheck
  lostCheck -- yes --> lostError
  lostCheck -- no --> returnResult
  awaitResult -. throws .-> emitError
  lostError -. caught .-> emitError
  emitError --> cleanup
  returnResult --> cleanup
  cleanup --> release
  release --> releaseOk
  releaseOk -- yes --> returnResult
  releaseOk -- throws --> releaseError
```

Important detail: release happens in a `finally` block, so the core attempts cleanup after successful tasks, thrown task errors, timeouts, and lock-loss errors.

## Option Normalization

The core never reads raw user options throughout the execution path. It first converts partial options into complete normalized option objects.

```mermaid
flowchart LR
  callOptions["per-call options"]
  instanceOptions["Leaseguard constructor options"]
  defaults["LEASEGUARD_DEFAULTS"]
  normalizedRun["NormalizedRunOptions"]
  normalizedAcquire["NormalizedAcquireOptions"]

  callOptions --> normalizedRun
  instanceOptions --> normalizedRun
  defaults --> normalizedRun

  callOptions --> normalizedAcquire
  instanceOptions --> normalizedAcquire
  defaults --> normalizedAcquire
```

Precedence is:

1. Per-call options, such as `ttlMs` passed to `run()` or `acquire()`.
2. Instance defaults, such as `defaultTtlMs` passed to `new Leaseguard(...)`.
3. `LEASEGUARD_DEFAULTS`.

For `run()`, the renewal interval defaults to the configured `defaultRenewIntervalMs` or one third of the TTL, with a lower bound from `renewIntervalFloorMs`.

## Acquisition And Retry Flow

`acquire()` is the lower-level path that returns a `LockHandle` when the lock is acquired, `undefined` when it is skipped, or throws when configured to throw on lock unavailability.

```mermaid
flowchart TD
  start["acquire(lockName, options)"]
  normalize["normalizeAcquireOptions()"]
  key["toKey(lockName)"]
  token["createToken(ownerId)"]
  loop["for attempt 1..retries + 1"]
  aborted{"signal aborted?"}
  storeAcquire["store.acquire(key, token, ttlMs)"]
  acquired{"acquired?"}
  emitAcquired["emit onAcquired"]
  handle["createHandle(...)"]
  moreRetries{"attempt <= retries?"}
  sleep["sleep(retryDelay + jitter, signal)"]
  emitSkipped["emit onSkipped"]
  throwOrSkip{"onLockUnavailable == throw?"}
  throwAcquire["throw LockAcquisitionError"]
  skip["return undefined"]

  start --> normalize
  normalize --> key
  key --> token
  token --> loop
  loop --> aborted
  aborted -- yes --> throwAcquire
  aborted -- no --> storeAcquire
  storeAcquire --> acquired
  acquired -- yes --> emitAcquired
  emitAcquired --> handle
  acquired -- no --> moreRetries
  moreRetries -- yes --> sleep
  sleep --> loop
  moreRetries -- no --> emitSkipped
  emitSkipped --> throwOrSkip
  throwOrSkip -- yes --> throwAcquire
  throwOrSkip -- no --> skip
```

`toKey()` rejects empty lock names and builds the storage key as:

```text
${keyPrefix}${lockName}
```

With defaults, `job` becomes `leaseguard:job`.

## Lock Handle And Execution Context

`createHandle()` builds one object that is both:

- A `LockContext`, passed to the user task.
- A `LockHandle`, used internally for renewal and release.

```mermaid
classDiagram
  class LockContext {
    readonly lockName
    readonly key
    readonly token
    readonly signal
    isLockLost()
    throwIfLockLost()
    checkOwnership()
  }

  class LockHandle {
    renew(ttlMs)
    release()
  }

  class LockExecutionContext {
    lost
    markLost()
    isLockLost()
    throwIfLockLost()
    checkOwnership()
  }

  LockContext <|.. LockExecutionContext
  LockContext <|.. LockHandle
  LockHandle <|.. LockExecutionContext
```

The context tracks lock loss with a local boolean and the execution `AbortSignal`. `isLockLost()` returns true when either the local lost flag is set or the signal is aborted.

`checkOwnership()` calls `store.isOwner(key, token)`. If Redis says the token no longer owns the key, the context marks itself as lost.

## Renewal Flow

`startRenewal()` starts a timer loop after acquisition and before the task is awaited.

```mermaid
sequenceDiagram
  participant Run as Leaseguard.run()
  participant Timer as renewal timer
  participant Handle as LockHandle
  participant Store as LockStore
  participant Redis as Redis
  participant Context as LockExecutionContext
  participant Hooks as lifecycle hooks

  Run->>Timer: startRenewal()
  loop until stopped
    Timer->>Handle: renew(ttlMs)
    Handle->>Store: renew(key, token, ttlMs)
    Store->>Redis: Lua: if GET key == token then PEXPIRE
    Redis-->>Store: 1 or 0
    Store-->>Handle: boolean
    alt renewed
      Handle->>Hooks: onRenewed(event)
    else not renewed
      Handle->>Context: markLost()
      Handle->>Hooks: onRenewFailed(event, LockLostError)
      Timer->>Timer: stop loop
    end
  end
  Run->>Timer: stopRenewal() in finally
```

The timer calls `timer.unref?.()` so the renewal timer does not keep the Node.js process alive by itself.

If renewal throws, `startRenewal()` marks the context as lost, emits `onRenewFailed`, and stops scheduling future renewal attempts.

## Timeout And Abort Flow

Timeout handling is implemented with `withTimeout()`, which races the task promise against a timer.

```mermaid
flowchart TD
  start["withTimeout(lockName, timeoutMs, taskPromise, executionController)"]
  timer["setTimeout(timeoutMs)"]
  race["Promise.race(taskPromise, timeoutPromise)"]
  taskWins{"Task settles first?"}
  clearTimer["finally: clearTimeout(timer)"]
  timeoutFires["Timer fires"]
  makeError["new LockTimeoutError(lockName, timeoutMs)"]
  abort["executionController.abort(error)"]
  reject["reject timeout promise"]

  start --> timer
  timer --> race
  race --> taskWins
  taskWins -- yes --> clearTimer
  taskWins -- no --> timeoutFires
  timeoutFires --> makeError
  makeError --> abort
  abort --> reject
  reject --> clearTimer
```

There are two abort sources:

1. A caller-provided `RunOptions.signal`.
2. The internal timeout controller.

`run()` forwards caller aborts into the internal execution controller. The task receives the internal `ctx.signal`, so timeout and caller cancellation share the same task-facing signal.

## Release Flow

Release is called in `run()` after task completion or failure. The handle also prevents duplicate local release calls.

```mermaid
sequenceDiagram
  participant Run as Leaseguard.run()
  participant Handle as LockHandle.release()
  participant Store as LockStore
  participant Redis as Redis
  participant Hooks as lifecycle hooks

  Run->>Handle: release()
  alt already released locally
    Handle-->>Run: false
  else first release
    Handle->>Store: release(key, token)
    Store->>Redis: Lua: if GET key == token then DEL
    Redis-->>Store: 1 or 0
    Store-->>Handle: boolean
    alt released by owner
      Handle->>Hooks: onReleased(event)
    end
    Handle-->>Run: boolean
  end
```

If the store throws while releasing, `release()` wraps that failure in `LockReleaseError`. `run()` then emits `onError` and throws.

## Redis Store Flow

The Redis store is intentionally narrow. It implements only the `LockStore` interface.

```mermaid
flowchart TD
  acquire["RedisLockStore.acquire(key, token, ttlMs)"]
  setnx["SET key token PX ttlMs NX"]
  acquireResult{"result == OK?"}

  renew["RedisLockStore.renew(key, token, ttlMs)"]
  renewLua["Lua renew script"]
  renewCheck{"GET key == token?"}
  pexpire["PEXPIRE key ttlMs"]
  renewZero["return 0"]

  release["RedisLockStore.release(key, token)"]
  releaseLua["Lua release script"]
  releaseCheck{"GET key == token?"}
  del["DEL key"]
  releaseZero["return 0"]

  owner["RedisLockStore.isOwner(key, token)"]
  get["GET key"]
  compare["compare stored token to caller token"]

  acquire --> setnx --> acquireResult
  renew --> renewLua --> renewCheck
  renewCheck -- yes --> pexpire
  renewCheck -- no --> renewZero
  release --> releaseLua --> releaseCheck
  releaseCheck -- yes --> del
  releaseCheck -- no --> releaseZero
  owner --> get --> compare
```

`acquire()` can use a single Redis command because Redis `SET ... NX PX ...` is already atomic. `renew()` and `release()` need Lua scripts because each operation must both check ownership and mutate the key without another client changing the key between those steps.

## Hook Emission

Hooks can be registered globally on the `Leaseguard` instance and locally on a `run()` or `acquire()` call. The core emits the global hook first, then the local hook.

```mermaid
flowchart LR
  event["event occurs"]
  global["this.options[hookName]?.(event)"]
  local["localHooks[hookName]?.(event)"]
  done["continue flow"]

  event --> global --> local --> done
```

The hook event object includes:

- `lockName`: caller-provided name.
- `key`: storage key after prefixing.
- `token`: owner token when available.
- `attempt`: acquisition attempt number.
- `error`: only for error hooks.

`onSkipped` can omit the token because the lock was not acquired.

## Error Paths

```mermaid
flowchart TD
  noTask["Missing task function"]
  badName["Empty lock name"]
  unavailableThrow["Lock unavailable and onLockUnavailable=throw"]
  lost["Task completed after context lost"]
  timeout["Task exceeds timeoutMs"]
  releaseFailure["Store release throws"]
  abort["AbortSignal already aborted or aborts during sleep"]

  noTask --> typeError["TypeError"]
  badName --> typeError
  unavailableThrow --> acquisition["LockAcquisitionError"]
  lost --> lostError["LockLostError"]
  timeout --> timeoutError["LockTimeoutError"]
  releaseFailure --> releaseError["LockReleaseError"]
  abort --> abortReason["signal.reason or Error('Operation aborted.')"]
```

Most task-path errors pass through `emitError()` before being rethrown. Acquisition failures happen before a handle exists, so they are handled by `acquire()` and do not run release cleanup.

## Test Coverage Map

`test/leaseguard.test.js` uses `MemoryLockStore` to test the core logic without Redis.

```mermaid
flowchart TD
  tests["test/leaseguard.test.js"]
  memory["MemoryLockStore"]
  core["Leaseguard"]

  tests --> memory
  tests --> core
  memory --> acquire["acquire false when key exists"]
  memory --> renew["renew true only for matching token"]
  memory --> release["release deletes only matching token"]
  memory --> owner["isOwner compares token"]
```

The current tests cover:

- Successful acquire, task execution, release, and hooks.
- Default skip behavior when a lock already exists.
- Throw behavior when a lock is unavailable.
- Retry behavior before acquisition succeeds.
- Timeout behavior, abort signaling, and release after timeout.

## Invariants

- Every successful acquisition has a unique token.
- Renewal and release must only succeed for the current owner token.
- The task receives a context tied to the acquired key and token.
- Renewal stops after task completion, task failure, timeout, release, or renewal failure.
- Release is attempted in `finally` whenever `run()` acquired a handle.
- Store implementations must preserve the `LockStore` ownership semantics.
