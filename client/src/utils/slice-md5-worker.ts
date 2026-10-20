import SparkMD5 from 'spark-md5';

// Hash one slice at a time; do not copy the whole file into the UI thread.
self.onmessage = async e => {
	const { targetFile, baseChunkSize } = e.data as { targetFile: File; baseChunkSize: number };
	const spark = new SparkMD5.ArrayBuffer();
	try {
		const size = Math.floor(baseChunkSize * 1024 * 1024);
		if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid chunk size');
		for (let start = 0; start < targetFile.size; start += size) {
			spark.append(await targetFile.slice(start, start + size).arrayBuffer());
		}
		self.postMessage({ messageType: 'success', fileHash: spark.end() });
	} catch {
		self.postMessage({ messageType: 'fail' });
	} finally {
		spark.destroy();
	}
};
