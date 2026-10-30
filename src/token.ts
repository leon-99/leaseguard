import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export function createOwnerId(): string {
  return `${hostname()}:pid-${process.pid}`;
}

export function createToken(ownerId: string): string {
  return `${ownerId}:${randomUUID()}`;
}
