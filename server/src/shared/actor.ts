export interface Actor {
	id: number | string;
	username: string;
	name?: string;
	avatar?: string;
	phone?: string;
}
export type SqlQuery = <T = unknown>(sql: string, values?: unknown) => Promise<T>;
