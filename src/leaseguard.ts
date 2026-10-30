import {
  LockAcquisitionError,
  LockLostError,
  LockReleaseError,
  LockTimeoutError
} from "./errors.js";
import { LEASEGUARD_DEFAULTS } from "./defaults.js";
import { createOwnerId, createToken } from "./token.js";
import type {
  AcquireOptions,
  LockContext,
  LockEvent,
  LeaseguardOptions,
  LockHandle,
  LockLifecycleHooks,
  LockTask,
  RunOptions
} from "./types.js";

interface NormalizedRunOptions extends RunOptions {
  ttlMs: number;
  renewIntervalMs: number;
  retries: number;
  retryDelayMs: number;
  retryJitterMs: number;
  onLockUnavailable: "skip" | "throw";
  throwOnLockLoss: boolean;
}

interface NormalizedAcquireOptions extends AcquireOptions {
  ttlMs: number;
  retries: number;
  retryDelayMs: number;
  retryJitterMs: number;
  onLockUnavailable: "skip" | "throw";
}

class LockExecutionContext implements LockContext {
  private lost = false;

  constructor(
    readonly lockName: string,
    readonly key: string,
    readonly token: string,
    readonly signal: AbortSignal,
    private readonly isOwnerFn: () => Promise<boolean>
  ) {}

  markLost(): void {
    this.lost = true;
  }

  isLockLost(): boolean {
    return this.lost || this.signal.aborted;
  }

  throwIfLockLost(): void {
    if (this.isLockLost()) {
      throw new LockLostError(this.lockName);
    }
  }

  async checkOwnership(): Promise<boolean> {
    const ownsLock = await this.isOwnerFn();
    if (!ownsLock) {
      this.markLost();
    }
    return ownsLock;
  }
}

export class Leaseguard {
  private readonly ownerId: string;
  private readonly keyPrefix: string;

  constructor(private readonly options: LeaseguardOptions) {
    this.ownerId = options.ownerId ?? createOwnerId();
    this.keyPrefix = options.keyPrefix ?? LEASEGUARD_DEFAULTS.keyPrefix;
  }

  async run<T>(lockName: string, task: LockTask<T>): Promise<T | undefined>;
  async run<T>(lockName: string, options: RunOptions, task: LockTask<T>): Promise<T | undefined>;
  async run<T>(
    lockName: string,
    optionsOrTask: RunOptions | LockTask<T>,
    maybeTask?: LockTask<T>
  ): Promise<T | undefined> {
    const task = typeof optionsOrTask === "function" ? optionsOrTask : maybeTask;
    if (!task) {
      throw new TypeError("Leaseguard.run requires a task function.");
    }

    const runOptions = this.normalizeRunOptions(
      typeof optionsOrTask === "function" ? {} : optionsOrTask
    );
    const executionController = new AbortController();
    const abortExecution = () => executionController.abort(runOptions.signal?.reason);
    runOptions.signal?.addEventListener("abort", abortExecution, { once: true });
    if (runOptions.signal?.aborted) {
      abortExecution();
    }

    let handle: LockHandle | undefined;
    try {
      handle = await this.acquire(lockName, {
        ...runOptions,
        signal: executionController.signal
      });
    } catch (error) {
      runOptions.signal?.removeEventListener("abort", abortExecution);
      throw error;
    }
    if (!handle) {
      runOptions.signal?.removeEventListener("abort", abortExecution);
      return undefined;
    }

    const context = handle as LockExecutionContext & LockHandle;
    const stopRenewal = this.startRenewal(lockName, handle, context, runOptions);

    try {
      let taskPromise = Promise.resolve(task(context));
      if (runOptions.timeoutMs !== undefined) {
        taskPromise = this.withTimeout(lockName, runOptions.timeoutMs, taskPromise, executionController);
      }

      const result = await taskPromise;
      if (runOptions.throwOnLockLoss && context.isLockLost()) {
        throw new LockLostError(lockName);
      }
      return result;
    } catch (error) {
      await this.emitError({ lockName, key: handle.key, token: handle.token, attempt: 1 }, error, runOptions);
      throw error;
    } finally {
      stopRenewal();
      runOptions.signal?.removeEventListener("abort", abortExecution);
      try {
        await handle.release();
      } catch (error) {
        await this.emitError({ lockName, key: handle.key, token: handle.token, attempt: 1 }, error, runOptions);
        throw error;
      }
    }
  }

  async acquire(lockName: string, options: AcquireOptions = {}): Promise<LockHandle | undefined> {
    const acquireOptions = this.normalizeAcquireOptions(options);
    const key = this.toKey(lockName);
    const token = createToken(this.ownerId);
    const abortSignal = acquireOptions.signal ?? new AbortController().signal;

    for (let attempt = 1; attempt <= acquireOptions.retries + 1; attempt += 1) {
      this.throwIfAborted(abortSignal);
      const acquired = await this.options.store.acquire(key, token, acquireOptions.ttlMs);
      const event = { lockName, key, token, attempt };

      if (acquired) {
        await this.emit("onAcquired", event, acquireOptions);
        return this.createHandle(lockName, key, token, abortSignal, acquireOptions.ttlMs, attempt, acquireOptions);
      }

      if (attempt <= acquireOptions.retries) {
        await sleep(this.retryDelay(acquireOptions), abortSignal);
      }
    }

    const skippedEvent = { lockName, key, attempt: acquireOptions.retries + 1 };
    await this.emit("onSkipped", skippedEvent, acquireOptions);
    if (acquireOptions.onLockUnavailable === "throw") {
      throw new LockAcquisitionError(lockName);
    }
    return undefined;
  }

  private createHandle(
    lockName: string,
    key: string,
    token: string,
    signal: AbortSignal,
    ttlMs: number,
    attempt: number,
    hooks: LockLifecycleHooks
  ): LockHandle {
    const context = new LockExecutionContext(lockName, key, token, signal, () =>
      this.options.store.isOwner(key, token)
    );
    let released = false;

    return Object.assign(context, {
      renew: async (nextTtlMs = ttlMs) => {
        const renewed = await this.options.store.renew(key, token, nextTtlMs);
        const event = { lockName, key, token, attempt };
        if (renewed) {
          await this.emit("onRenewed", event, hooks);
        } else {
          context.markLost();
          await this.emitRenewFailed(event, new LockLostError(lockName), hooks);
        }
        return renewed;
      },
      release: async () => {
        if (released) {
          return false;
        }
        released = true;
        try {
          const releasedByOwner = await this.options.store.release(key, token);
          if (releasedByOwner) {
            await this.emit("onReleased", { lockName, key, token, attempt }, hooks);
          }
          return releasedByOwner;
        } catch (error) {
          throw new LockReleaseError(lockName, { cause: error });
        }
      }
    });
  }

  private startRenewal(
    lockName: string,
    handle: LockHandle,
    context: LockExecutionContext,
    options: NormalizedRunOptions
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      timer = setTimeout(() => {
        void (async () => {
          if (stopped) {
            return;
          }
          try {
            const renewed = await handle.renew(options.ttlMs);
            if (!renewed) {
              context.markLost();
              stopped = true;
              return;
            }
          } catch (error) {
            context.markLost();
            stopped = true;
            await this.emitRenewFailed(
              { lockName, key: handle.key, token: handle.token, attempt: 1 },
              error,
              options
            );
            return;
          }
          tick();
        })();
      }, options.renewIntervalMs);
      timer.unref?.();
    };

    tick();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }

  private normalizeRunOptions(options: RunOptions): NormalizedRunOptions {
    const ttlMs = options.ttlMs ?? this.options.defaultTtlMs ?? LEASEGUARD_DEFAULTS.ttlMs;
    return {
      ...options,
      ttlMs,
      renewIntervalMs:
        options.renewIntervalMs ??
        this.options.defaultRenewIntervalMs ??
        Math.max(LEASEGUARD_DEFAULTS.renewIntervalFloorMs, Math.floor(ttlMs / 3)),
      retries: options.retries ?? this.options.defaultRetries ?? LEASEGUARD_DEFAULTS.retries,
      retryDelayMs:
        options.retryDelayMs ?? this.options.defaultRetryDelayMs ?? LEASEGUARD_DEFAULTS.retryDelayMs,
      retryJitterMs:
        options.retryJitterMs ?? this.options.defaultRetryJitterMs ?? LEASEGUARD_DEFAULTS.retryJitterMs,
      onLockUnavailable:
        options.onLockUnavailable ??
        this.options.defaultOnLockUnavailable ??
        LEASEGUARD_DEFAULTS.onLockUnavailable,
      throwOnLockLoss:
        options.throwOnLockLoss ?? this.options.throwOnLockLoss ?? LEASEGUARD_DEFAULTS.throwOnLockLoss
    };
  }

  private normalizeAcquireOptions(options: AcquireOptions): NormalizedAcquireOptions {
    return {
      ...options,
      ttlMs: options.ttlMs ?? this.options.defaultTtlMs ?? LEASEGUARD_DEFAULTS.ttlMs,
      retries: options.retries ?? this.options.defaultRetries ?? LEASEGUARD_DEFAULTS.retries,
      retryDelayMs:
        options.retryDelayMs ?? this.options.defaultRetryDelayMs ?? LEASEGUARD_DEFAULTS.retryDelayMs,
      retryJitterMs:
        options.retryJitterMs ?? this.options.defaultRetryJitterMs ?? LEASEGUARD_DEFAULTS.retryJitterMs,
      onLockUnavailable:
        options.onLockUnavailable ??
        this.options.defaultOnLockUnavailable ??
        LEASEGUARD_DEFAULTS.onLockUnavailable
    };
  }

  private toKey(lockName: string): string {
    if (!lockName || lockName.trim().length === 0) {
      throw new TypeError("Lock name must be a non-empty string.");
    }
    return `${this.keyPrefix}${lockName}`;
  }

  private retryDelay(options: Pick<NormalizedAcquireOptions, "retryDelayMs" | "retryJitterMs">): number {
    if (options.retryJitterMs <= 0) {
      return options.retryDelayMs;
    }
    return options.retryDelayMs + Math.floor(Math.random() * options.retryJitterMs);
  }

  private async withTimeout<T>(
    lockName: string,
    timeoutMs: number,
    taskPromise: Promise<T>,
    executionController: AbortController
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new LockTimeoutError(lockName, timeoutMs);
        executionController.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([taskPromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
    }
  }

  private async emit<K extends keyof LockLifecycleHooks>(
    hookName: K,
    event: Parameters<NonNullable<LockLifecycleHooks[K]>>[0],
    localHooks: LockLifecycleHooks
  ): Promise<void> {
    await Promise.resolve(this.options[hookName]?.(event as never));
    await Promise.resolve(localHooks[hookName]?.(event as never));
  }

  private async emitRenewFailed(event: LockEvent, error: unknown, localHooks: LockLifecycleHooks): Promise<void> {
    await Promise.resolve(this.options.onRenewFailed?.({ ...event, error }));
    await Promise.resolve(localHooks.onRenewFailed?.({ ...event, error }));
  }

  private async emitError(event: LockEvent, error: unknown, localHooks: LockLifecycleHooks): Promise<void> {
    await Promise.resolve(this.options.onError?.({ ...event, error }));
    await Promise.resolve(localHooks.onError?.({ ...event, error }));
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
      },
      { once: true }
    );
  });
}

export function createLeaseguard(options: LeaseguardOptions): Leaseguard {
  return new Leaseguard(options);
}
