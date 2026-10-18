import { better_chat } from './redis';

// All bucket decisions/debits are atomic; a rejection spends none of the buckets.
// Fetch Redis time separately for compatibility with older Redis Lua replication.
const script = `
local now = tonumber(ARGV[1])
local values = {}
local times = {}
local wait = 0
for i, key in ipairs(KEYS) do
  local rate = tonumber(ARGV[(i-1)*2+2])
  local cap = tonumber(ARGV[(i-1)*2+3])
  local old = redis.call('HMGET', key, 'tokens', 'time')
  local previous = tonumber(old[2]) or now
  local effective = math.max(now, previous)
  local tokens = math.min(cap, (tonumber(old[1]) or cap) + (effective-previous)*rate/1000)
  values[i] = tokens
  times[i] = effective
  if tokens < 1 then wait = math.max(wait, math.ceil((1-tokens)*1000/rate)) end
end
if wait > 0 then return wait end
for i, key in ipairs(KEYS) do
  local rate = tonumber(ARGV[(i-1)*2+2])
  local cap = tonumber(ARGV[(i-1)*2+3])
  -- Separate fields also support Redis versions before multi-field HSET.
  redis.call('HSET', key, 'tokens', values[i]-1)
  redis.call('HSET', key, 'time', times[i])
  redis.call('PEXPIRE', key, math.ceil(cap/rate*1000)+1000)
end
return 0
`;
export const consumeTokenBuckets = async (
	buckets: Array<{ key: string; rate: number; capacity: number }>
): Promise<number> => {
	if (
		!buckets.length ||
		buckets.some(
			b => !Number.isFinite(b.rate) || b.rate <= 0 || !Number.isFinite(b.capacity) || b.capacity < 1
		)
	)
		throw new Error('Invalid token bucket');
	const time = await better_chat.time();
	const now = Number(time[0]) * 1000 + Number(time[1]) / 1000;
	if (!Number.isFinite(now)) throw new Error('Invalid Redis time');
	const result = Number(
		await better_chat.eval(
			script,
			buckets.length,
			...buckets.map(b => b.key),
			now,
			...buckets.flatMap(b => [b.rate, b.capacity])
		)
	);
	if (!Number.isFinite(result) || result < 0) throw new Error('Invalid token bucket response');
	return result;
};
