import * as repository from '../repository';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	type StdioServerParameters
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool } from 'langchain';
import { z } from 'zod';

interface ExternalMcpServerConfig {
	name: string;
	type?: 'stdio' | 'sse' | 'streamableHttp';
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	category?: 'calendar' | 'files' | 'web' | 'other';
	enabled?: boolean;
	allowedTools?: string[];
	readTools?: string[];
	writeTools?: string[];
	idempotencyKeys?: Record<string, string>;
	allowedUserIds?: number[];
}

interface ConnectedMcpServer {
	config: ExternalMcpServerConfig;
	client: Client;
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

const optionalString = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

const optionalStringArray = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;

const optionalStringRecord = (value: unknown): Record<string, string> | undefined => {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	return entries.every(([, item]) => typeof item === 'string')
		? (Object.fromEntries(entries) as Record<string, string>)
		: undefined;
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const parseServerConfig = (value: unknown): ExternalMcpServerConfig | null => {
	if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
	const command = optionalString(value.command);
	const url = optionalString(value.url);
	if (!command && !url) return null;
	const type =
		value.type === 'stdio' || value.type === 'sse' || value.type === 'streamableHttp'
			? value.type
			: undefined;
	const category =
		value.category === 'calendar' ||
		value.category === 'files' ||
		value.category === 'web' ||
		value.category === 'other'
			? value.category
			: undefined;
	return {
		name: value.name,
		type,
		command,
		args: optionalStringArray(value.args),
		cwd: optionalString(value.cwd),
		env: optionalStringRecord(value.env),
		url,
		headers: optionalStringRecord(value.headers),
		category,
		enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
		allowedTools: optionalStringArray(value.allowedTools),
		readTools: optionalStringArray(value.readTools),
		writeTools: optionalStringArray(value.writeTools),
		idempotencyKeys: optionalStringRecord(value.idempotencyKeys),
		allowedUserIds:
			Array.isArray(value.allowedUserIds) &&
			value.allowedUserIds.length === 1 &&
			value.allowedUserIds.every(id => Number.isSafeInteger(id) && id > 0)
				? (value.allowedUserIds as number[])
				: undefined
	};
};

const expandEnv = (value: string): string =>
	value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] || '');

const expandHeaders = (headers?: Record<string, string>): Record<string, string> | undefined =>
	headers
		? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, expandEnv(value)]))
		: undefined;

const parseConfig = (): ExternalMcpServerConfig[] => {
	const raw = process.env.MCP_SERVERS_JSON;
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an array.');
		return parsed
			.map(parseServerConfig)
			.filter((item): item is ExternalMcpServerConfig => item !== null);
	} catch (error: unknown) {
		console.error(`[assistant-mcp] invalid MCP_SERVERS_JSON: ${errorMessage(error)}`);
		return [];
	}
};

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);

const sharedArgsSchema = z.record(z.string(), z.unknown());
const MCP_TIMEOUT_MS = 5000;
const TOOL_CACHE_MS = 60000;

export const isMcpToolAllowed = (
	config: Pick<
		ExternalMcpServerConfig,
		'readTools' | 'writeTools' | 'allowedTools' | 'allowedUserIds'
	>,
	userId: number,
	name: string
): boolean =>
	config.allowedUserIds?.length === 1 &&
	config.allowedUserIds[0] === userId &&
	(config.allowedTools === undefined || config.allowedTools.includes(name)) &&
	(config.readTools?.includes(name) === true || config.writeTools?.includes(name) === true);

const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out`)), MCP_TIMEOUT_MS);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const hasMcpIdempotencyContract = (key: string | undefined, schema: unknown): boolean => {
	if (!key || !isRecord(schema) || !isRecord(schema.properties)) return false;
	const field = schema.properties[key];
	return (
		isRecord(field) &&
		field.type === 'string' &&
		Array.isArray(schema.required) &&
		schema.required.includes(key)
	);
};

const auditMcpTool = (
	event: string,
	payload: {
		tool: string;
		server?: string;
		userId?: number;
		requiresConfirmation?: boolean;
		confirmed?: boolean;
		status?: string;
		errorMessage?: string;
	}
): Promise<void> => {
	console.log(
		JSON.stringify({
			event,
			tool: payload.tool,
			server: payload.server,
			requiresConfirmation: payload.requiresConfirmation,
			confirmed: payload.confirmed,
			status: payload.status,
			at: new Date().toISOString()
		})
	);
	return repository
		.insertMcpAudit([
			payload.userId ?? null,
			payload.server || null,
			payload.tool,
			event,
			payload.requiresConfirmation ? 1 : 0,
			payload.confirmed ? 1 : 0,
			payload.status || 'unknown',
			payload.errorMessage ? payload.errorMessage.slice(0, 500) : null
		])
		.then(() => undefined)
		.catch(error => {
			console.error(`[assistant-mcp] failed to persist audit log: ${errorMessage(error)}`);
		});
};

class ExternalMcpManager {
	private connections = new Map<string, Promise<ConnectedMcpServer>>();
	private toolCache = new Map<
		string,
		{ expiresAt: number; tools: Awaited<ReturnType<Client['listTools']>>['tools'] }
	>();
	private activeKeys = new Map<string, string>();

	async close(): Promise<void> {
		const connections = [...this.connections.values()];
		this.connections.clear();
		this.toolCache.clear();
		this.activeKeys.clear();
		await Promise.allSettled(
			connections.map(async connection => (await connection).client.close())
		);
	}

	private configKey(config: ExternalMcpServerConfig): string {
		return JSON.stringify(config);
	}

	private invalidate(key: string): void {
		this.toolCache.delete(key);
		const connection = this.connections.get(key);
		this.connections.delete(key);
		if (connection)
			void connection.then(connected => connected.client.close()).catch(() => undefined);
	}

	private connect(config: ExternalMcpServerConfig): Promise<ConnectedMcpServer> {
		const key = this.configKey(config);
		const previousKey = this.activeKeys.get(config.name);
		if (previousKey && previousKey !== key) this.invalidate(previousKey);
		this.activeKeys.set(config.name, key);
		const existing = this.connections.get(key);
		if (existing) return existing;
		let client: Client | undefined;
		let transport: ConnectedMcpServer['transport'] | undefined;
		const connection = (async () => {
			if (config.url) {
				const requestInit = { headers: expandHeaders(config.headers) };
				transport =
					config.type === 'sse'
						? new SSEClientTransport(new URL(config.url), { requestInit })
						: new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
			} else {
				const stdioConfig: StdioServerParameters = {
					command: config.command!,
					args: config.args,
					env: config.env
						? ({ ...process.env, ...config.env } as Record<string, string>)
						: undefined,
					cwd: config.cwd,
					stderr: 'pipe'
				};
				transport = new StdioClientTransport(stdioConfig);
			}
			client = new Client({ name: 'pomelo-chat-agent', version: '1.0.0' }, { capabilities: {} });
			await client.connect(transport);
			return { config, client, transport };
		})();
		const guarded = withTimeout(connection, `MCP ${config.name} connection`).catch(error => {
			if (this.connections.get(key) === guarded) this.invalidate(key);
			void client?.close().catch(() => undefined);
			void transport?.close().catch(() => undefined);
			void connection.then(connected => connected.client.close()).catch(() => undefined);
			throw error;
		});
		this.connections.set(key, guarded);
		return guarded;
	}

	async getTools(userId: number) {
		const configs = parseConfig().filter(
			item => item.enabled !== false && item.allowedUserIds?.includes(userId)
		);
		const result = [] as Array<{
			definition: Record<string, unknown>;
			serverName: string;
			invoke: (args: Record<string, unknown>) => Promise<unknown>;
			requiresConfirmation: boolean;
			idempotencyKey?: string;
		}>;
		const groups = await Promise.all(
			configs.map(async config => {
				const group: typeof result = [];
				const key = this.configKey(config);
				try {
					const connected = await this.connect(config);
					let cached = this.toolCache.get(key);
					if (!cached || cached.expiresAt <= Date.now()) {
						const listed = await withTimeout(
							connected.client.listTools(),
							`MCP ${config.name} tools`
						);
						cached = { expiresAt: Date.now() + TOOL_CACHE_MS, tools: listed.tools || [] };
						this.toolCache.set(key, cached);
					}
					for (const remoteTool of cached.tools) {
						if (!isMcpToolAllowed(config, userId, remoteTool.name)) continue;
						const isWrite = config.writeTools?.includes(remoteTool.name) === true;
						const idempotencyKey = config.idempotencyKeys?.[remoteTool.name];
						if (isWrite && !hasMcpIdempotencyContract(idempotencyKey, remoteTool.inputSchema)) {
							console.error(
								`[assistant-mcp] write tool ${config.name}/${remoteTool.name} lacks declared idempotency input`
							);
							continue;
						}
						const name = `mcp_${safeName(config.name)}_${safeName(remoteTool.name)}`;
						group.push({
							definition: {
								name,
								description: `[External MCP: ${config.name}] ${remoteTool.description || remoteTool.name}. Input schema: ${JSON.stringify(remoteTool.inputSchema || {})}`,
								kind: 'external',
								inputSchema: remoteTool.inputSchema || { type: 'object' }
							},
							serverName: config.name,
							invoke: async args => {
								try {
									return await withTimeout(
										connected.client.callTool({ name: remoteTool.name, arguments: args }),
										`MCP ${config.name}/${remoteTool.name} call`
									);
								} catch (error) {
									if (errorMessage(error).includes('timed out')) this.invalidate(key);
									throw error;
								}
							},
							requiresConfirmation: isWrite,
							idempotencyKey
						});
					}
				} catch (error: unknown) {
					this.invalidate(key);
					console.error(`[assistant-mcp] failed to load ${config.name}: ${errorMessage(error)}`);
				}
				return group;
			})
		);
		result.push(...groups.flat());
		return result;
	}

	async buildTools(userId: number) {
		const remoteTools = await this.getTools(userId);
		return remoteTools
			.filter(remote => !remote.requiresConfirmation)
			.map(remote =>
				tool(async args => JSON.stringify(await remote.invoke(args as Record<string, unknown>)), {
					name: String(remote.definition.name),
					description: String(remote.definition.description),
					schema: sharedArgsSchema
				})
			);
	}

	async getTool(name: string, userId: number) {
		return (await this.getTools(userId)).find(item => item.definition.name === name);
	}

	async isWriteTool(name: string, userId: number): Promise<boolean> {
		return (await this.getTool(name, userId))?.requiresConfirmation === true;
	}

	async executeConfirmedTool(
		name: string,
		args: Record<string, unknown>,
		userId: number,
		confirmationId?: string
	) {
		const remote = await this.getTool(name, userId);
		if (!remote) throw new Error(`Unknown external MCP tool: ${name}`);
		if (remote.requiresConfirmation && (!confirmationId || !remote.idempotencyKey))
			throw new Error('External write requires a confirmation id and idempotency contract');
		if (!remote.requiresConfirmation && confirmationId)
			throw new Error('Tool classification changed');
		const callArgs = remote.requiresConfirmation
			? { ...args, [remote.idempotencyKey!]: confirmationId }
			: args;
		await auditMcpTool('mcp_tool_call', {
			tool: name,
			server: remote.serverName,
			userId,
			requiresConfirmation: remote.requiresConfirmation,
			confirmed: remote.requiresConfirmation,
			status: 'started'
		});
		try {
			const result = await remote.invoke(callArgs);
			if (isRecord(result) && result.isError === true)
				throw new Error('External MCP tool reported an error');
			await auditMcpTool('mcp_tool_call', {
				tool: name,
				server: remote.serverName,
				userId,
				requiresConfirmation: remote.requiresConfirmation,
				confirmed: remote.requiresConfirmation,
				status: 'success'
			});
			return result;
		} catch (error) {
			await auditMcpTool('mcp_tool_call', {
				tool: name,
				server: remote.serverName,
				userId,
				requiresConfirmation: remote.requiresConfirmation,
				confirmed: remote.requiresConfirmation,
				status: 'error',
				errorMessage: errorMessage(error)
			});
			throw error;
		}
	}
}

export const externalMcpManager = new ExternalMcpManager();
