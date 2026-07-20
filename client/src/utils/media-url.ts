import { serverURL } from '@/config';
import { tokenStorage } from '@/utils/storage';

export const getAuthorizedMediaURL = (path: string): string => {
	if (!path) return '';
	if (!path.startsWith('/uploads/')) return path.startsWith('http') ? path : `${serverURL}${path}`;
	const token = tokenStorage.getItem();
	const url = new URL(`${serverURL}${path}`);
	if (token) url.searchParams.set('token', token);
	return url.toString();
};
