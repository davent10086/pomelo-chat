import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
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
	writeTools?: string[];
}

interface ConnectedMcpServer {
	config: ExternalMcpServerConfig;
	client: Client;
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
}

const expandEnv = (value: string): string =>
	value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] || '');

const expandHeaders = (headers?: Record<string, string>): Record<string, string> | undefined =>
	headers ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, expandEnv(value)])) : undefined;

const parseConfig = (): ExternalMcpServerConfig[] => {
	const raw = process.env.MCP_SERVERS_JSON;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an array.');
		return parsed.filter(item =>
			item && typeof item.name === 'string' &&
			((typeof item.command === 'string' && item.command.length > 0) || (typeof item.url === 'string' && item.url.length > 0))
		);
	} catch (error: any) {
		console.error(`[assistant-mcp] invalid MCP_SERVERS_JSON: ${error.message}`);
		return [];
	}
};

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);

const sharedArgsSchema = z.record(z.string(), z.unknown());

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
		const result = [] as Array<{ definition: Record<string, unknown>; invoke: (args: Record<string, unknown>) => Promise<unknown>; requiresConfirmation: boolean }>;
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
						invoke: args => connected.client.callTool({ name: remoteTool.name, arguments: args }),
						requiresConfirmation: config.writeTools?.includes(remoteTool.name) === true
					});
				}
			} catch (error: any) {
				console.error(`[assistant-mcp] failed to load ${config.name}: ${error.message}`);
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

	async callTool(name: string, args: Record<string, unknown>, confirmed = false) {
		const remote = (await this.getTools()).find(item => item.definition.name === name);
		if (!remote) throw new Error(`Unknown external MCP tool: ${name}`);
		if (remote.requiresConfirmation && !confirmed) {
			return { requiresConfirmation: true, tool: name, message: 'This MCP operation changes external data. Confirm before executing.' };
		}
		return remote.invoke(args);
	}
}

export const externalMcpManager = new ExternalMcpManager();
