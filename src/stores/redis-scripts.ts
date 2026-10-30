export interface RedisLockScripts {
  renew: string;
  release: string;
}

export const REDIS_LOCK_SCRIPTS: RedisLockScripts = {
  renew: `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`,
  release: `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`
};
