export const LEASEGUARD_DEFAULTS = {
  keyPrefix: "leaseguard:",
  ttlMs: 30_000,
  renewIntervalFloorMs: 100,
  retryDelayMs: 250,
  retries: 0,
  retryJitterMs: 0,
  onLockUnavailable: "skip",
  throwOnLockLoss: true
} as const;
