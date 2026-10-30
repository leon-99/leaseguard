export class LeaseguardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LockAcquisitionError extends LeaseguardError {
  constructor(lockName: string) {
    super(`Could not acquire lock "${lockName}".`);
  }
}

export class LockLostError extends LeaseguardError {
  constructor(lockName: string, options?: ErrorOptions) {
    super(`Lock "${lockName}" was lost while the task was running.`, options);
  }
}

export class LockTimeoutError extends LeaseguardError {
  constructor(lockName: string, timeoutMs: number) {
    super(`Lock task "${lockName}" exceeded timeout of ${timeoutMs}ms.`);
  }
}

export class LockReleaseError extends LeaseguardError {
  constructor(lockName: string, options?: ErrorOptions) {
    super(`Failed to release lock "${lockName}".`, options);
  }
}
