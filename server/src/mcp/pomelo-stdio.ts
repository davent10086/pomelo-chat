import 'dotenv/config';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import {
	executePomeloTool,
	pomeloToolDefinitions,
	type PomeloToolContext
} from '../service/assistant/tools/pomelo-tools';

const parseUserId = (): number => {
	const userId = Number(process.env.POMELO_MCP_USER_ID);
	if (!Number.isFinite(userId) || userId <= 0) {
		throw new Error('POMELO_MCP_USER_ID must be set to a valid Pomelo user id.');
	}
	return userId;
};

export const createPomeloMcpServer = (context: PomeloToolContext): McpServer => {
	const server = new McpServer(
		{
			name: 'pomelo-chat-mcp',
			version: '1.0.0'
		},
		{
			capabilities: {
				tools: {}
			}
		}
	);

	for (const definition of pomeloToolDefinitions) {
		server.registerTool(
			definition.name,
			{
				title: definition.name,
				description: `${definition.description} Kind: ${definition.kind}.`,
				inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType)
			},
			async args => {
				const result = await executePomeloTool(context, {
					name: definition.name,
					args: args as Record<string, unknown>
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(result, null, 2)
						}
					],
					structuredContent: result
				};
			}
		);
	}

	return server;
};

if (require.main === module) {
	try {
		const context: PomeloToolContext = {
			userId: parseUserId(),
			currentRoom: process.env.POMELO_MCP_ROOM || undefined
		};
		serveStdio(() => createPomeloMcpServer(context), {
			onerror: error => {
				console.error(`[pomelo-mcp] ${error.message}`);
			}
		});
	} catch (err: any) {
		console.error(`[pomelo-mcp] ${err.message}`);
		process.exit(1);
	}
}
