export interface Outcome {
	code: number;
	data: unknown;
}
export const success = (data: unknown = '', code = 200): Outcome => ({ code, data });
export const failure = (code: number): Outcome => ({ code, data: '' });
