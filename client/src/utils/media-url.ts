import { serverURL } from '@/config';
import { tokenStorage } from '@/utils/storage';
import request from '@/utils/request';
import { useEffect, useState } from 'react';

const cache = new Map<string, { expiresAt: number; value: Promise<string> }>();
export const getAuthorizedMediaURL = async (path: string): Promise<string> => {
	if (!path) return '';
	if (!path.startsWith('/uploads/')) return path.startsWith('http') ? path : `${serverURL}${path}`;
	const token = tokenStorage.getItem();
	const key = `${token}:${path}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	if (cache.size >= 200) cache.clear();
	const value = request.post<{ path: string }, { access: string; expiresIn: number }>('/file/media_access', { path }).then(result => {
		if (tokenStorage.getItem() !== token || result.data.code !== 200) throw new Error('附件访问权限已变化');
	const url = new URL(`${serverURL}${path}`);
	url.searchParams.set('access', result.data.data.access);
	return url.toString();
	}).catch(error => { cache.delete(key); throw error; });
	cache.set(key, { value, expiresAt: Date.now() + 240000 });
	return value;
};

export const useAuthorizedMediaURL = (path: string): string => {
	const token = tokenStorage.getItem();
	const [resolved, setResolved] = useState<{ path: string; token: string; url: string }>();
	useEffect(() => {
		if (!path.startsWith('/uploads/')) return;
		let active = true;
		const load = () => { void getAuthorizedMediaURL(path).then(url => { if (active) setResolved({ path, token, url }); }).catch(() => { if (active) setResolved({ path, token, url: '' }); }); };
		load();
		const refresh = setInterval(load, 240000);
		return () => { active = false; clearInterval(refresh); };
	}, [path, token]);
	if (!path) return '';
	if (!path.startsWith('/uploads/')) return path.startsWith('http') ? path : `${serverURL}${path}`;
	return resolved?.path === path && resolved.token === token ? resolved.url : '';
};
