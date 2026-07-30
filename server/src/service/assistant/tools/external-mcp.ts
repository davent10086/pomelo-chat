import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool } from 'langchain';
import { z } from 'zod';
import { Query } from '../../../utils/query';

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
	writeTools?: string[];
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
		? Object.fromEntries(entries) as Record<string, string>
		: undefined;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const parseServerConfig = (value: unknown): ExternalMcpServerConfig | null => {
	if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
	const command = optionalString(value.command);
	const url = optionalString(value.url);
	if (!command && !url) return null;
	const type = value.type === 'stdio' || value.type === 'sse' || value.type === 'streamableHttp'
		? value.type
		: undefined;
	const category = value.category === 'calendar' || value.category === 'files' || value.category === 'web' || value.category === 'other'
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
		writeTools: optionalStringArray(value.writeTools)
	};
};

const expandEnv = (value: string): string =>
	value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] || '');

const expandHeaders = (headers?: Record<string, string>): Record<string, string> | undefined =>
	headers ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, expandEnv(value)])) : undefined;

const parseConfig = (): ExternalMcpServerConfig[] => {
	const raw = process.env.MCP_SERVERS_JSON;
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an array.');
		return parsed.map(parseServerConfig).filter((item): item is ExternalMcpServerConfig => item !== null);
	} catch (error: unknown) {
		console.error(`[assistant-mcp] invalid MCP_SERVERS_JSON: ${errorMessage(error)}`);
		return [];
	}
};

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);

const sharedArgsSchema = z.record(z.string(), z.unknown());

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
	console.log(JSON.stringify({
		event,
		tool: payload.tool,
		server: payload.server,
		requiresConfirmation: payload.requiresConfirmation,
		confirmed: payload.confirmed,
		status: payload.status,
		at: new Date().toISOString()
	}));
	return Query(
		`INSERT INTO mcp_audit_log
		 (user_id, server_name, tool, event, requires_confirmation, confirmed, status, error_message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			payload.userId ?? null,
			payload.server || null,
			payload.tool,
			event,
			payload.requiresConfirmation ? 1 : 0,
			payload.confirmed ? 1 : 0,
			payload.status || 'unknown',
			payload.errorMessage ? payload.errorMessage.slice(0, 500) : null
		]
	).then(() => undefined).catch(error => {
		console.error(`[assistant-mcp] failed to persist audit log: ${errorMessage(error)}`);
	});
};

class ExternalMcpManager {
	private connections = new Map<string, Promise<ConnectedMcpServer>>();

	private connect(config: ExternalMcpServerConfig): Promise<ConnectedMcpServer> {
		const existing = this.connections.get(config.name);
		if (existing) return existing;
		const connection = (async () => {
			let transport: ConnectedMcpServer['transport'];
			if (config.url) {
				const requestInit = { headers: expandHeaders(config.headers) };
				transport = config.type === 'sse'
					? new SSEClientTransport(new URL(config.url), { requestInit })
					: new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
			} else {
				const stdioConfig: StdioServerParameters = {
					command: config.command!,
					args: config.args,
					env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
					cwd: config.cwd,
					stderr: 'pipe'
				};
				transport = new StdioClientTransport(stdioConfig);
			}
			const client = new Client({ name: 'pomelo-chat-agent', version: '1.0.0' }, { capabilities: {} });
			await client.connect(transport);
			return { config, client, transport };
		})();
		this.connections.set(config.name, connection);
		return connection;
	}

	async getTools() {
		const configs = parseConfig().filter(item => item.enabled !== false);
		const result = [] as Array<{
			definition: Record<string, unknown>;
			serverName: string;
			invoke: (args: Record<string, unknown>) => Promise<unknown>;
			requiresConfirmation: boolean;
		}>;
		for (const config of configs) {
			try {
				const connected = await this.connect(config);
				const listed = await connected.client.listTools();
				for (const remoteTool of listed.tools || []) {
					if (config.allowedTools?.length && !config.allowedTools.includes(remoteTool.name)) continue;
					const name = `mcp_${safeName(config.name)}_${safeName(remoteTool.name)}`;
					result.push({
						definition: {
							name,
							description: `[External MCP: ${config.name}] ${remoteTool.description || remoteTool.name}. Input schema: ${JSON.stringify(remoteTool.inputSchema || {})}`,
							kind: 'external',
							inputSchema: remoteTool.inputSchema || { type: 'object' }
						},
						serverName: config.name,
						invoke: args => connected.client.callTool({ name: remoteTool.name, arguments: args }),
						requiresConfirmation: config.writeTools?.includes(remoteTool.name) === true
					});
				}
			} catch (error: unknown) {
				console.error(`[assistant-mcp] failed to load ${config.name}: ${errorMessage(error)}`);
			}
		}
		return result;
	}

	async buildTools() {
		const remoteTools = await this.getTools();
		return remoteTools.filter(remote => !remote.requiresConfirmation).map(remote =>
			tool(async args => JSON.stringify(await remote.invoke(args as Record<string, unknown>)), {
				name: String(remote.definition.name),
				description: String(remote.definition.description),
				schema: sharedArgsSchema
			})
		);
	}

	async callTool(name: string, args: Record<string, unknown>, confirmed = false, userId?: number) {
		const remote = (await this.getTools()).find(item => item.definition.name === name);
		if (!remote) throw new Error(`Unknown external MCP tool: ${name}`);
		if (remote.requiresConfirmation && !confirmed) {
			await auditMcpTool('mcp_tool_confirmation_required', {
				tool: name,
				server: remote.serverName,
				userId,
				requiresConfirmation: true,
				confirmed: false,
				status: 'pending'
			});
			return { requiresConfirmation: true, tool: name, message: 'This MCP operation changes external data. Confirm before executing.' };
		}
		await auditMcpTool('mcp_tool_call', {
			tool: name,
			server: remote.serverName,
			userId,
			requiresConfirmation: remote.requiresConfirmation,
			confirmed,
			status: 'started'
		});
		try {
			const result = await remote.invoke(args);
			await auditMcpTool('mcp_tool_call', {
				tool: name,
				server: remote.serverName,
				userId,
				requiresConfirmation: remote.requiresConfirmation,
				confirmed,
				status: 'success'
			});
			return result;
		} catch (error) {
			await auditMcpTool('mcp_tool_call', {
				tool: name,
				server: remote.serverName,
				userId,
				requiresConfirmation: remote.requiresConfirmation,
				confirmed,
				status: 'error',
				errorMessage: errorMessage(error)
			});
			throw error;
		}
	}
}

export const externalMcpManager = new ExternalMcpManager();
