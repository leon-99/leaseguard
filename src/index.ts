export { lock } from "./facade.js";
export type { LeaseguardSetupOptions } from "./facade.js";
export { LEASEGUARD_DEFAULTS } from "./defaults.js";
export {
  LockAcquisitionError,
  LockLostError,
  LockReleaseError,
  LockTimeoutError,
  LeaseguardError
} from "./errors.js";
export type {
  LockContext,
  LockEvent,
  LockErrorEvent,
  LockLifecycleHooks,
  LockTask,
  LockUnavailableStrategy,
  RunOptions
} from "./types.js";
