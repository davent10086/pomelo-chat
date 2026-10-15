import 'dotenv/config';
import { toolErrorResult } from '../modules/assistant/tools/tool-runtime';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import {
	executePomeloTool,
	pomeloToolDefinitions,
	type PomeloToolContext
} from '../modules/assistant/public';

const parseUserId = (): number => {
	const userId = Number(process.env.POMELO_MCP_USER_ID);
	if (!Number.isSafeInteger(userId) || userId <= 0) {
		throw new Error('POMELO_MCP_USER_ID must be set to a valid Pomelo user id.');
	}
	return userId;
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

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

	for (const definition of pomeloToolDefinitions.filter(item => item.kind !== 'write')) {
		server.registerTool(
			definition.name,
			{
				title: definition.name,
				description: `${definition.description} Kind: ${definition.kind}.`,
				inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType),
				outputSchema: fromJsonSchema(definition.outputSchema as JsonSchemaType),
				annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
			},
			async args => {
				try {
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
				} catch (error) {
					const result = toolErrorResult(error);
					return {
						isError: true,
						content: [{ type: 'text' as const, text: JSON.stringify(result) }]
					};
				}
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
	} catch (err: unknown) {
		console.error(`[pomelo-mcp] ${errorMessage(err)}`);
		process.exit(1);
	}
}
