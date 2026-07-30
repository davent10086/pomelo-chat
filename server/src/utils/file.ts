// 根据文件名获取文件类型
export const getFileSuffixByName = (filename: string): 'video' | 'image' | 'file' => {
	const fileSuffix = filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
	switch (fileSuffix) {
		case 'avi':
		case 'mpeg':
		case 'wmv':
		case 'mov':
		case 'flv':
		case 'mp4':
			return 'video';
		case 'png':
		case 'jpeg':
		case 'jpg':
		case 'gif':
		case 'webp':
			return 'image';
		default:
			return 'file';
	}
};

const allowedExtensions = new Set([
	'png',
	'jpeg',
	'jpg',
	'gif',
	'webp',
	'mp4',
	'mov',
	'webm',
	'pdf',
	'txt',
	'md',
	'doc',
	'docx',
	'xls',
	'xlsx',
	'ppt',
	'pptx',
	'zip',
	'rar',
	'7z'
]);

export const isAllowedUploadMime = (mime: unknown): boolean => {
	if (typeof mime !== 'string') return true;
	return (
		mime.startsWith('image/') ||
		mime.startsWith('video/') ||
		mime === 'application/pdf' ||
		mime === 'text/plain' ||
		mime === 'text/markdown' ||
		mime === 'application/zip' ||
		mime === 'application/x-7z-compressed' ||
		mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
		mime === 'application/msword' ||
		mime === 'application/vnd.ms-excel' ||
		mime === 'application/vnd.ms-powerpoint' ||
		mime === 'application/octet-stream'
	);
};

export const normalizeUploadMetadata = (fileHash: unknown, extension: unknown) => {
	if (typeof fileHash !== 'string' || !/^[a-f0-9]{32,64}$/i.test(fileHash)) return null;
	if (typeof extension !== 'string') return null;
	const ext = extension.replace(/^\./, '').toLowerCase();
	if (!/^[a-z0-9]{1,10}$/.test(ext)) return null;
	if (!allowedExtensions.has(ext)) return null;
	return { fileHash: fileHash.toLowerCase(), ext, suffix: getFileSuffixByName(ext) };
};
