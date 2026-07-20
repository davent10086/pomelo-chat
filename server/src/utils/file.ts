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
		case 'svg':
			return 'image';
		default:
			return 'file';
	}
};

export const normalizeUploadMetadata = (fileHash: unknown, extension: unknown) => {
	if (typeof fileHash !== 'string' || !/^[a-f0-9]{32,64}$/i.test(fileHash)) return null;
	if (typeof extension !== 'string') return null;
	const ext = extension.replace(/^\./, '').toLowerCase();
	if (!/^[a-z0-9]{1,10}$/.test(ext)) return null;
	return { fileHash: fileHash.toLowerCase(), ext, suffix: getFileSuffixByName(ext) };
};
