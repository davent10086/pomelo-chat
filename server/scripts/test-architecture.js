const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const ownership = {
	identity: ['user'],
	social: ['friend', 'friend_group', 'group_chat', 'group_members'],
	messaging: [
		'message',
		'conversation',
		'conversation_read',
		'message_statistics',
		'message_outbox',
		'message_attachment'
	],
	files: ['file_metadata'],
	assistant: ['assistant_action', 'assistant_task', 'assistant_memory', 'mcp_audit_log'],
	rtc: [],
	realtime: []
};
const moduleOf = file => /^modules\/([^/]+)\//.exec(file)?.[1];
const adapter = file =>
	moduleOf(file) === 'realtime' ||
	/(?:^|\/)(?:http|middleware|access-http|agent-http)\.ts$/.test(file);
function checkSources(sources) {
	const errors = [],
		graph = new Map();
	for (const [file, text] of Object.entries(sources)) {
		const own = moduleOf(file);
		if (own && !graph.has(own)) graph.set(own, new Set());
		const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		function visit(node) {
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const specifier = node.moduleSpecifier.text;
				if (own && !adapter(file) && ['express', 'express-ws', 'ws'].includes(specifier))
					errors.push(`${file}: transport dependency ${specifier} in business code`);
				if (specifier.startsWith('.')) {
					const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
					const other = moduleOf(target);
					if (own && !file.endsWith('/repository.ts') && target === 'infrastructure/database')
						errors.push(`${file}: pool access outside repository`);
					if (
						own &&
						!file.endsWith('/repository.ts') &&
						target === 'infrastructure/database-query' &&
						ts.isImportDeclaration(node) &&
						node.importClause?.namedBindings &&
						ts.isNamedImports(node.importClause.namedBindings) &&
						node.importClause.namedBindings.elements.some(
							item => (item.propertyName || item.name).text === 'Query'
						)
					)
						errors.push(`${file}: direct SQL import outside repository`);
					if (own && own !== 'realtime' && file.endsWith('/public.ts') && adapter(`${target}.ts`))
						errors.push(`${file}: public API exports a transport adapter`);
					if (/^(service|utils)\/|^model\/db$/.test(target))
						errors.push(`${file}: legacy import ${specifier}`);
					if (own && other && own !== other && !/(?:^|\/)(public|contracts)$/.test(target))
						errors.push(`${file}: imports internal file of ${other}: ${specifier}`);
					const typeOnly = ts.isImportDeclaration(node)
						? node.importClause?.isTypeOnly ||
							(node.importClause?.namedBindings &&
								ts.isNamedImports(node.importClause.namedBindings) &&
								node.importClause.namedBindings.elements.every(e => e.isTypeOnly))
						: node.isTypeOnly;
					if (own && other && own !== other && !typeOnly && !target.endsWith('/contracts'))
						graph.get(own).add(other);
					if (
						/^(infrastructure|shared|read-models)\//.test(file) &&
						/^(modules|service|utils|model|controller)\//.test(target)
					)
						errors.push(`${file}: lower layer depends on ${target}`);
				}
			}
			if (
				own &&
				!file.endsWith('/repository.ts') &&
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				['Query', 'query'].includes(node.expression.text)
			)
				errors.push(`${file}: SQL execution outside repository`);
			if (
				(own || file.startsWith('read-models/')) &&
				(ts.isStringLiteral(node) ||
					ts.isNoSubstitutionTemplateLiteral(node) ||
					ts.isTemplateExpression(node))
			) {
				const literal = ts.isTemplateExpression(node) ? node.head.text : node.text;
				if (
					/^\s*(?:SELECT\b[\s\S]*\bFROM\b|INSERT(?:\s+IGNORE)?\s+INTO\b|UPDATE\s+\S+[\s\S]*\bSET\b|DELETE\s+FROM\b)/i.test(
						literal
					) &&
					!file.endsWith('/repository.ts') &&
					!file.startsWith('read-models/')
				)
					errors.push(`${file}: SQL outside repository/read model`);
				const write = /^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/i.exec(
					literal
				);
				if (write && file.startsWith('read-models/')) errors.push(`${file}: write in read model`);
				if (write && own && !ownership[own]?.includes(write[1]))
					errors.push(`${file}: ${own} writes table owned elsewhere: ${write[1]}`);
			}
			ts.forEachChild(node, visit);
		}
		visit(ast);
	}
	const visited = new Set(),
		stack = [];
	function visitModule(name) {
		if (stack.includes(name)) {
			errors.push(`module cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
			return;
		}
		if (visited.has(name)) return;
		stack.push(name);
		for (const next of graph.get(name) || []) visitModule(next);
		stack.pop();
		visited.add(name);
	}
	for (const name of graph.keys()) visitModule(name);
	return [...new Set(errors)];
}
function sourcesAt(directory) {
	const sources = {};
	function scan(folder) {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			const file = path.join(folder, entry.name);
			if (entry.isDirectory()) scan(file);
			else if (entry.name.endsWith('.ts'))
				sources[path.relative(directory, file).split(path.sep).join('/')] = fs.readFileSync(
					file,
					'utf8'
				);
		}
	}
	scan(directory);
	return sources;
}
if (require.main === module) {
	const errors = checkSources(sourcesAt(root));
	if (errors.length) {
		console.error(errors.join('\n'));
		process.exitCode = 1;
	} else
		console.log(
			'[architecture] module APIs, transport boundaries, SQL ownership and acyclic dependencies passed'
		);
}
module.exports = { checkSources };
