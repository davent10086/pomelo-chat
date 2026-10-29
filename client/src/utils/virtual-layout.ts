export const buildHeightOffsets = (count: number, heightAt: (index: number) => number): number[] => {
	const offsets = new Array<number>(count + 1);
	offsets[0] = 0;
	for (let index = 0; index < count; index++) offsets[index + 1] = offsets[index] + heightAt(index);
	return offsets;
};

/** Find the first item's bottom at or beyond offset, including exact boundaries. */
export const findHeightIndex = (offsets: number[], offset: number): number => {
	let low = 0, high = Math.max(0, offsets.length - 2);
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (offsets[middle + 1] >= offset) high = middle;
		else low = middle + 1;
	}
	return low;
};
