export interface LockStore {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
  isOwner(key: string, token: string): Promise<boolean>;
}

export interface LockEvent {
  lockName: string;
  key: string;
  token: string;
  attempt: number;
}

export interface LockErrorEvent extends LockEvent {
  error: unknown;
}

export interface LockLifecycleHooks {
  onAcquired?(event: LockEvent): void | Promise<void>;
  onReleased?(event: LockEvent): void | Promise<void>;
  onRenewed?(event: LockEvent): void | Promise<void>;
  onRenewFailed?(event: LockErrorEvent): void | Promise<void>;
  onSkipped?(event: Omit<LockEvent, "token"> & { token?: string }): void | Promise<void>;
  onError?(event: LockErrorEvent): void | Promise<void>;
}

export type LockUnavailableStrategy = "skip" | "throw";

export interface LeaseguardOptions extends LockLifecycleHooks {
  store: LockStore;
  keyPrefix?: string;
  defaultTtlMs?: number;
  defaultRenewIntervalMs?: number;
  defaultRetries?: number;
  defaultRetryDelayMs?: number;
  defaultRetryJitterMs?: number;
  defaultOnLockUnavailable?: LockUnavailableStrategy;
  throwOnLockLoss?: boolean;
  ownerId?: string;
}

export interface RunOptions extends LockLifecycleHooks {
  ttlMs?: number;
  renewIntervalMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLockUnavailable?: LockUnavailableStrategy;
  throwOnLockLoss?: boolean;
}

export interface AcquireOptions extends LockLifecycleHooks {
  ttlMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  signal?: AbortSignal;
  onLockUnavailable?: LockUnavailableStrategy;
}

export interface LockContext {
  readonly lockName: string;
  readonly key: string;
  readonly token: string;
  readonly signal: AbortSignal;
  isLockLost(): boolean;
  throwIfLockLost(): void;
  checkOwnership(): Promise<boolean>;
}

export interface LockHandle extends LockContext {
  renew(ttlMs?: number): Promise<boolean>;
  release(): Promise<boolean>;
}

export type LockTask<T> = (context: LockContext) => Promise<T> | T;
