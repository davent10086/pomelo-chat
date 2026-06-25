// AES-GCM 加密工具（随机 IV + 认证加密）
// 注意：前端硬编码密钥仍可被提取，机密性应依赖 HTTPS。此处仅做对称加密的语义安全修复。

// 从环境变量读取密钥（Vite 内联），回退到内置值（仅用于非敏感场景）
const RAW_KEY = import.meta.env.VITE_ENCRYPT_KEY || 'a2b7e151628aed2a6abf7158809cf4f3';

// 将字符串 key 转换为 CryptoKey 类型（AES-GCM 128/256 取决于 key 长度）
const importKey = async () => {
	const encoder = new TextEncoder();
	// 确保密钥为 16/32 字节（AES-128/256）
	const keyBytes = encoder.encode(RAW_KEY);
	const validLen = keyBytes.length >= 32 ? 32 : 16;
	const keyData = new Uint8Array(validLen);
	keyData.set(keyBytes.subarray(0, validLen));
	const importedKey = await crypto.subtle.importKey(
		'raw',
		keyData,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	);
	return importedKey;
};

// hex 字符串 → Uint8Array
const hexToBytes = (hex: string) => {
	const arr = new Uint8Array(hex.length / 2);
	for (let i = 0; i < arr.length; i++) {
		arr[i] = parseInt(hex.substr(i * 2, 2), 16);
	}
	return arr;
};

// Uint8Array → hex 字符串
const bytesToHex = (bytes: Uint8Array) => {
	return Array.from(bytes)
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
};

// AES-GCM 加密：返回 "iv:cipher" 的 hex 格式（IV 非秘密，可随密文一同传输）
export const encrypt = async (data: string) => {
	const importedKey = await importKey();
	// GCM 推荐 12 字节随机 IV
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		importedKey,
		new TextEncoder().encode(data)
	);
	return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(cipher))}`;
};

// AES-GCM 解密：接收 "iv:cipher" 的 hex 格式
export const decrypt = async (str: string) => {
	const importedKey = await importKey();
	const [ivHex, cipherHex] = str.split(':');
	if (!ivHex || !cipherHex) throw new Error('invalid cipher format');
	const iv = hexToBytes(ivHex);
	const buffer = hexToBytes(cipherHex);
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		importedKey,
		buffer
	);
	return new TextDecoder().decode(decrypted);
};

// 兼容旧版调用：尝试新格式失败时回退旧 CBC 全零 IV（用于过渡期，可移除）
export const decryptLegacy = async (str: string) => {
	try {
		return await decrypt(str);
	} catch {
		// 旧格式：纯 hex 密文，CBC 全零 IV
		const legacyKey = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(RAW_KEY).subarray(0, 16),
			{ name: 'AES-CBC' },
			false,
			['decrypt']
		);
		const buffer = hexToBytes(str);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-CBC', iv: new Uint8Array(16) },
			legacyKey,
			buffer
		);
		return new TextDecoder().decode(decrypted);
	}
};

// 随机生成一个字符串进行显示加密
export const generateRandomString = () => {
	const randomValues = new Uint32Array(4);
	crypto.getRandomValues(randomValues);
	return Array.from(randomValues, decimal => decimal.toString(16)).join('');
};
