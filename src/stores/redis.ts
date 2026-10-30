import type { LockStore } from "../types.js";
import { REDIS_LOCK_SCRIPTS, type RedisLockScripts } from "./redis-scripts.js";

export interface RedisLike {
  set(
    key: string,
    value: string,
    px: "PX",
    ttlMs: number,
    nx: "NX"
  ): Promise<"OK" | null>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<number | string>;
  get(key: string): Promise<string | null>;
}

export interface RedisLockStoreOptions {
  scripts?: Partial<RedisLockScripts>;
}

export class RedisLockStore implements LockStore {
  private readonly scripts: RedisLockScripts;

  constructor(
    private readonly client: RedisLike,
    options: RedisLockStoreOptions = {}
  ) {
    this.scripts = {
      ...REDIS_LOCK_SCRIPTS,
      ...options.scripts
    };
  }

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, token, "PX", ttlMs, "NX");
    return result === "OK";
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.eval(this.scripts.renew, 1, key, token, ttlMs);
    return Number(result) === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    const result = await this.client.eval(this.scripts.release, 1, key, token);
    return Number(result) === 1;
  }

  async isOwner(key: string, token: string): Promise<boolean> {
    return (await this.client.get(key)) === token;
  }
}
