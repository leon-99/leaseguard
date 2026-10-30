# Leaseguard


A production-grade distributed locking library for Node.js that allows multiple servers, containers, workers, or application instances to coordinate access to shared resources and critical operations.

The package ensures that only one process can execute a protected section of code at a time, preventing race conditions, duplicate processing, double execution, and data corruption in horizontally scaled environments.

Problem

Modern Node.js applications often run across multiple replicas:

App Instance 1
App Instance 2
App Instance 3
Worker Instance 1
Worker Instance 2

When multiple instances execute the same operation simultaneously, problems can occur:

Duplicate cron execution
Duplicate task processing
Duplicate API requests
Double resource updates
Conflicting database writes
Overlapping background jobs
Race conditions

A distributed lock allows one process to claim ownership of a task while all other processes wait, skip, or retry.

Core Concept

A process acquires a named lock before executing critical code.

await lock.run("task:123", async () => {
  await runTask(123);
});

If another process already owns the lock:

Lock Acquired → Run Task
Lock Exists → Skip / Retry

The package manages acquisition, ownership validation, renewal, and safe release automatically.

Key Features
Distributed Locking

Coordinate execution across:

Multiple Node.js servers
Docker containers
Kubernetes pods
Background workers
Cron processes
Queue consumers
Automatic Lock Renewal

Long-running tasks should not lose ownership simply because the original lock TTL expires.

The package automatically starts a watchdog that renews the lock while the task is running.

await lock.run("cleanup-job", async () => {
  await runCleanup();
});

Internally:

Acquire Lock
↓
Start Renewal Watchdog
↓
Run Task
↓
Renew Lock Periodically
↓
Task Completes
↓
Stop Renewal
↓
Release Lock

This prevents situations where:

Task starts
↓
TTL expires
↓
Another server acquires lock
↓
Two servers run same task
Lock Ownership Protection

Every lock is associated with a unique owner token.

server-1:pid-4821:uuid

Only the owner may:

Renew the lock
Release the lock

This prevents one process from accidentally modifying another process's lock.

Lock Loss Detection

Distributed systems are unreliable.

Network interruptions or Redis outages can cause a lock to expire unexpectedly.

The package provides lock ownership awareness during execution.

await lock.run("batch-job", async (ctx) => {
  for (const item of items) {
    ctx.throwIfLockLost();

    await processItem(item);
  }
});

This allows applications to stop safely if ownership is lost.

Safe Release

The package guarantees that a process cannot accidentally release a lock that has already been acquired by another process.

All ownership validation and release operations are performed atomically.

Retry and Backoff

Applications may choose to wait and retry when a lock is already owned.

await lock.run("data-sync", {
  retries: 5,
  retryDelayMs: 1000,
}, async () => {
  await syncData();
});
Timeout Protection

Tasks can define maximum execution times.

await lock.run("long-running-job", {
  timeoutMs: 300000,
}, async () => {
  await runLongTask();
});
Lifecycle Hooks

Observe lock activity for monitoring and logging.

{
  onAcquired,
  onReleased,
  onRenewed,
  onRenewFailed,
  onSkipped,
  onError
}
Common Use Cases
Task Processing
await lock.run(`task:${taskId}`, async () => {
  await processTask(taskId);
});
Resource Updates
await lock.run(`resource:${resourceId}`, async () => {
  await updateResource(resourceId);
});
Rollback Protection
await lock.run(`rollback:${operationId}`, async () => {
  await rollbackOperation(operationId);
});
Cron Jobs
await lock.run("cleanup-job", async () => {
  await runCleanup();
});
Data Synchronization
await lock.run("data-sync", async () => {
  await syncData();
});
Background Workers
await lock.run(`job:${jobId}`, async () => {
  await processJob(jobId);
});
Design Goals
Production-first design
Simple developer experience
Automatic lock renewal
Safe ownership validation
Protection against distributed race conditions
Minimal dependencies
Promise-based API
Predictable failure handling
Suitable for high-throughput systems
Works reliably in multi-instance deployments
Philosophy

Most locking libraries expose low-level primitives and leave safety concerns to the developer.

This package focuses on providing a safe execution model out of the box.

Developers should be able to wrap critical code with a single function call and trust that:

Only one process executes it
Long-running tasks retain ownership through automatic renewal
Lost locks are detectable
Cleanup is performed safely
Common distributed locking mistakes are prevented by default

The goal is to make distributed locking simple enough for everyday use while remaining reliable enough for systems handling background processing, shared resources, scheduled jobs, and other critical workloads.
