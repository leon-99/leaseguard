import { Redis, type RedisOptions } from "ioredis";
import { Leaseguard, createLeaseguard } from "./leaseguard.js";
import { RedisLockStore, type RedisLike, type RedisLockStoreOptions } from "./stores/redis.js";
import type {
  LeaseguardOptions,
  LockTask,
  RunOptions
} from "./types.js";

export interface LeaseguardSetupOptions extends Omit<LeaseguardOptions, "store"> {
  redis?: RedisOptions;
  redisStore?: RedisLockStoreOptions;
}

class LeaseguardFacade {
  private instance?: Leaseguard;
  private redis?: Redis;

  setup(redisUrl: string | undefined, options: LeaseguardSetupOptions = {}): Leaseguard {
    if (!redisUrl) {
      throw new Error("Leaseguard requires a Redis URL. Pass lock.setup(redisUrl) during app startup.");
    }

    const { redis: redisOptions, redisStore, ...leaseguardOptions } = options;

    this.redis?.disconnect();
    this.redis = new Redis(redisUrl, redisOptions ?? {});
    this.instance = createLeaseguard({
      ...leaseguardOptions,
      store: new RedisLockStore(toRedisLike(this.redis), redisStore)
    });

    return this.instance;
  }

  async run<T>(lockName: string, task: LockTask<T>): Promise<T | undefined>;
  async run<T>(lockName: string, options: RunOptions, task: LockTask<T>): Promise<T | undefined>;
  async run<T>(
    lockName: string,
    optionsOrTask: RunOptions | LockTask<T>,
    maybeTask?: LockTask<T>
  ): Promise<T | undefined> {
    const instance = this.getInstance();

    if (typeof optionsOrTask === "function") {
      return instance.run(lockName, optionsOrTask);
    }

    if (!maybeTask) {
      throw new TypeError("lock.run requires a task function.");
    }

    return instance.run(lockName, optionsOrTask, maybeTask);
  }

  async close(): Promise<void> {
    this.redis?.disconnect();
    this.redis = undefined;
    this.instance = undefined;
  }

  isConfigured(): boolean {
    return this.instance !== undefined;
  }

  private getInstance(): Leaseguard {
    if (!this.instance) {
      throw new Error("Leaseguard has not been configured. Call lock.setup(redisUrl) during app startup.");
    }
    return this.instance;
  }
}

export const lock = new LeaseguardFacade();

function toRedisLike(redis: Redis): RedisLike {
  return {
    set: (key, value, px, ttlMs, nx) => redis.set(key, value, px, ttlMs, nx),
    eval: async (script, keyCount, ...args) => {
      const result = await redis.eval(script, keyCount, ...args);
      if (typeof result === "number" || typeof result === "string") {
        return result;
      }
      return Number(result);
    },
    get: (key) => redis.get(key)
  };
}
