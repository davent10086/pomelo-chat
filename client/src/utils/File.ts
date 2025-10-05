import { ChatImage } from "@/assets/images";

/**
 * 根据文件路径获取文件后缀并返回对应的文件类型
 * @param path - 包含文件信息的路径字符串
 * @returns 返回文件类型：'video'(视频), 'image'(图片) 或 'default'(默认)
 */
export const getFileSuffixByPath = (path: string) => {
	const filename = new URLSearchParams(path.split('?')[1]).get('filename');
    const fileSuffix = filename!.substring(filename!.lastIndexOf('.') + 1).toLowerCase();
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
			return 'default';
    }
}

/**
 * 根据文件名获取文件后缀并返回对应的文件类型
 * @param fileName - 文件名字符串
 * @returns 返回文件类型：'video'(视频), 'image'(图片) 或 'file'(文件)
 */
export const getChatSuffixByPath = (fileName :string) => {
    const fileSuffix = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
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

/**
 * 根据文件路径获取对应的文件图标
 * @param path - 文件路径字符串
 * @returns 返回对应文件类型的图标
 */
export const getFileIcon = (path: string) => {
    const fileSuffix = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
	switch (fileSuffix) {
		case 'docx':
		case 'doc':
			return ChatImage.WORD;
		case 'xls':
		case 'xlsx':
			return ChatImage.EXCEL;
		case 'ppt':
		case 'pptx':
			return ChatImage.PPT;
		case 'pdf':
			return ChatImage.PDF;
		case 'apk':
			return ChatImage.APK;
		case 'exe':
			return ChatImage.EXE;
		case 'rar':
		case 'zip':
		case 'gz':
		case 'tar':
		case '7z':
			return ChatImage.ZIP;
		case 'avi':
		case 'mpeg':
		case 'wmv':
		case 'mov':
		case 'flv':
		case 'mp4':
			return ChatImage.MP4;
		case 'txt':
			return ChatImage.TXT;
		default:
			return ChatImage.DEFAULT;
	}
};

/**
 * 从路径中提取文件名
 * @param path - 完整文件路径
 * @returns 返回文件名
 */
export const getFileName = (path: string) => {
	const fileName = path.split('/').pop();
	return fileName;
};

/**
 * 根据图片/视频链接获得图片/视频宽高
 * @param mediaUrl - 媒体文件的URL地址
 * @param mediaType - 媒体类型 ('image' 或 'video')
 * @returns 返回包含宽度和高度的Promise对象
 */
export const getMediaSize = (
	mediaUrl: string,
	mediaType: string
): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		if (mediaType === 'image') {
			const mediaElement = document.createElement('img');
			mediaElement.src = mediaUrl;
			mediaElement.onload = () => {
				resolve({ width: mediaElement.width, height: mediaElement.height });
			};
			mediaElement.onerror = () => {
				reject(new Error(`图片加载失败`));
			};
		} else if (mediaType === 'video') {
			const mediaElement = document.createElement('video');
			mediaElement.src = mediaUrl;
			mediaElement.addEventListener('canplay', () => {
				resolve({ width: mediaElement.videoWidth, height: mediaElement.videoHeight });
			});
		}
	});
};

/**
 * 根据实际宽高计算展示的合理宽高
 * @param size - 包含原始宽度和高度的对象
 * @param mediaType - 媒体类型 ('image' 或 'video')
 * @returns 返回适合展示的宽度样式对象
 */
export const getMediaShowSize = (
	size: { width: number; height: number },
	mediaType: 'image' | 'video'
): { width: string } => {
	if (mediaType === 'image') {
		const widthRem = size.width / 1000;
		if (widthRem < 1) {
			return { width: `${widthRem + 0.2}rem` };
		} else if (widthRem < 3) {
			return { width: `${widthRem}rem` };
		} else {
			return { width: `${3}rem` };
		}
	} else {
		// 横屏
		if (size.width > size.height) {
			return { width: `${2.5}rem` };
		} else {
			return { width: `${1}rem` };
		}
	}
};

/**
 * 文件下载功能
 * @param url - 要下载的文件URL
 */
export const downloadFile = (url: string) => {
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = '';

		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	} catch {
		return;
	}
};

/**
 * 判断某个文件是否存在
 * @param url - 要检查的文件URL
 * @returns 返回文件是否存在的布尔值
 */
export const urlExists = async (url: string) => {
	try {
		const response = await fetch(url, { method: 'HEAD' });
		return response.ok;
	} catch {
		return false;
	}
};