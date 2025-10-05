const key = 'a2b7e151628aed2a6abf7158809cf4f3';

/**
 * 导入加密密钥
 * 
 * @returns 返回Promise，解析为CryptoKey对象，可用于AES-CBC加密和解密操作
 */
const importKey = async () => {
    const encoder = new TextEncoder();
    const Keydata = encoder.encode(key);
    const importedKey = await crypto.subtle.importKey(
        'raw',
        Keydata,
        {
            name: 'AES-CBC',
        },
        false,
        ['encrypt', 'decrypt']
    );
    return importedKey;
};

/**
 * 加密数据
 * 
 * @param data - 需要加密的字符串数据
 * @returns 返回Promise，解析为加密后的十六进制字符串
 */
export const encrypt = async (data: string) => {
    const importedKey = await importKey();
    // 使用AES-CBC模式加密数据，IV固定为16字节的零数组
    const cipher = await crypto.subtle.encrypt(
        {name: 'AES-CBC', iv: new ArrayBuffer(16)},
        importedKey,
        new TextEncoder().encode(data),
    );
    // 将加密结果转换为十六进制字符串
    return Array.from(new Uint8Array(cipher))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
};
/**
 * 解密函数
 * @param str - 需要解密的十六进制字符串
 * @returns 解密后的明文字符串
 */
export const decrypt = async (str: string) => {
	// 导入解密所需的密钥
	const importedKey = await importKey();
	
	// 将十六进制字符串转换为字节数组
	const buffer = new Uint8Array(str.match(/.{2}/g)!.map(b => parseInt(b, 16)));
	
	// 使用AES-CBC算法解密数据
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-CBC', iv: new Uint8Array(16) },
		importedKey,
		buffer
	);
	
	// 将解密后的字节数据转换为文本字符串
	return new TextDecoder().decode(decrypted);
};

/**
 * 生成随机字符串
 * 
 * @returns 返回由4个随机32位整数转换为十六进制组成的字符串
 */
export const generateRandomString = () => {
	const randomValues = new Uint32Array(4);
	crypto.getRandomValues(randomValues);
	return Array.from(randomValues, decimal => decimal.toString(16)).join('');
};
