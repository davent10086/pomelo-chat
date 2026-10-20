import { better_chat } from '../../infrastructure/redis';
import { boundedInteger } from '../../shared/validation';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { uploadRoot } from '../../infrastructure/file-storage';

export const maxUploadBytes = boundedInteger('MAX_UPLOAD_SIZE_BYTES', 100 * 1024 * 1024, 1);
const userBudget = boundedInteger('MAX_USER_UPLOAD_BYTES', 500 * 1024 * 1024, maxUploadBytes);
const maxSessions = boundedInteger('MAX_USER_UPLOAD_SESSIONS', 20, 1, 100);
export const admitUploadSession = async (user: string, session: string) => Number(await better_chat.eval(`
redis.call('ZREMRANGEBYSCORE',KEYS[1],0,ARGV[1])
if not redis.call('ZSCORE',KEYS[1],ARGV[2]) and redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) then return 0 end
redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]); return 1`, 1, `upload:active:${user}`, Date.now(), session, Date.now() + 3600000, maxSessions)) === 1;
const reservation = `
local old=tonumber(redis.call('HGET',KEYS[1],ARGV[1]) or '0')
local total=0; local session=0
local items=redis.call('HGETALL',KEYS[1])
for i=1,#items,2 do
 total=total+tonumber(items[i+1])
 if string.sub(items[i],1,string.len(ARGV[2]))==ARGV[2] then session=session+tonumber(items[i+1]) end
end
local delta=tonumber(ARGV[3])-old
if total+delta>tonumber(ARGV[4]) or session+delta>tonumber(ARGV[5]) then return -1 end
redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]); return old`;

export const reserveChunk = async (user: string, session: string, index: number, size: number) =>
	Number(await better_chat.eval(reservation, 1, `upload:quota:${user}`, `${session}:${index}`, `${session}:`, size, userBudget, maxUploadBytes));
export const releaseUploadQuota = async (user: string, session: string) => {
	await better_chat.eval(`local fields=redis.call('HKEYS',KEYS[1]); for _,key in ipairs(fields) do
if string.sub(key,1,string.len(ARGV[1]))==ARGV[1] then redis.call('HDEL',KEYS[1],key) end end return 1`, 1, `upload:quota:${user}`, `${session}:`);
	await better_chat.zrem(`upload:active:${user}`, session);
};

/** One lease per canonical upload; all writers and the collector use this boundary. */
export const withUploadLease = async <T>(sessionKey: string, work: (assertLease: () => Promise<void>) => Promise<T>): Promise<T> => {
	const key = `${sessionKey}:lock`, token = randomUUID();
	let acquired = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await better_chat.set(key, token, 'PX', 120000, 'NX')) { acquired = true; break; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!acquired) throw new Error('Upload busy; retry later');
	let lost = false;
	const assertLease = async () => {
		if (lost || await better_chat.get(key) !== token) { lost = true; throw new Error('Upload lease lost'); }
	};
	const heartbeat = setInterval(() => { void better_chat.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) end return 0", 1, key, token).then(result => { if (Number(result) !== 1) lost = true; }).catch(() => { lost = true; }); }, 30000);
	heartbeat.unref();
	try { await assertLease(); const result = await work(assertLease); await assertLease(); return result; }
	finally { clearInterval(heartbeat); await better_chat.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token); }
};

/** Only expired chunk directories under numeric user IDs are eligible; ready files are never removed. */
export const collectExpiredUploads = async () => {
	for (const user of await fs.readdir(uploadRoot).catch(() => [] as string[])) {
		if (!/^[1-9]\d*$/.test(user)) continue;
		if (!(await fs.lstat(join(uploadRoot, user))).isDirectory() || (await fs.lstat(join(uploadRoot, user))).isSymbolicLink()) continue;
		for (const suffix of await fs.readdir(join(uploadRoot, user)).catch(() => [] as string[])) {
			if (!/^[a-z]+$/.test(suffix)) continue;
			if (!(await fs.lstat(join(uploadRoot, user, suffix))).isDirectory() || (await fs.lstat(join(uploadRoot, user, suffix))).isSymbolicLink()) continue;
			for (const hash of await fs.readdir(join(uploadRoot, user, suffix)).catch(() => [] as string[])) {
				const match = /^([a-f0-9]{32}|[a-f0-9]{64})-([a-z0-9]+)$/.exec(hash);
				if (!match) continue;
				const dir = join(uploadRoot, user, suffix, hash);
				if (!(await fs.lstat(dir)).isDirectory() || (await fs.lstat(dir)).isSymbolicLink()) continue;
				const metadata = await fs.readFile(join(dir, '.upload.json'), 'utf8').then(value => JSON.parse(value) as { ext: string }).catch(() => null);
				if (!metadata || !/^[a-z0-9]+$/.test(metadata.ext)) continue;
				if (metadata.ext !== match[2]) continue;
				const session = `${match[1]}:${metadata.ext}`;
				const key = `upload:session:${user}:${session}`;
				if (await better_chat.exists(key)) continue;
				await withUploadLease(key, async assertLease => {
					if (await better_chat.exists(key)) return;
					await assertLease();
					await fs.rm(dir, { recursive: true, force: true });
					await assertLease();
					await releaseUploadQuota(user, session);
				});
			}
		}
	}
};
let timer: ReturnType<typeof setInterval> | undefined;
let collecting: Promise<void> | undefined;
export const startUploadCleanup = () => {
	if (timer) return;
	timer = setInterval(() => {
		if (!collecting) collecting = collectExpiredUploads().catch(error => console.error('[file] cleanup:', error)).finally(() => { collecting = undefined; });
	}, 60000);
	timer.unref();
};
export const stopUploadCleanup = async () => { if (timer) clearInterval(timer); timer = undefined; await collecting; };
