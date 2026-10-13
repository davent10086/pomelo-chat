const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assertIncludes = (file, pattern, label) => {
	const text = read(file);
	const ok = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
	if (!ok) {
		throw new Error(`${label} missing in ${file}`);
	}
};















assertIncludes('client/src/pages/chat/useChatSocket.ts', "message.name === 'ack'", 'client ack handling');
assertIncludes('client/src/pages/chat/useChatSocket.ts', "return false", 'client failed send handling');
assertIncludes('client/src/pages/chat/useReadReceipt.ts', 'markChatRead', 'frontend read cursor reporting');
assertIncludes('client/src/components/MessageShow/index.tsx', '发送失败', 'failed send indicator');









assertIncludes('client/src/components/ChatContainer/index.tsx', 'visibleRange', 'virtualized chat visible range');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'measuredHeights', 'dynamic row height cache');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'topPlaceholderHeight', 'virtualized top spacer');
assertIncludes('client/src/components/ChatContainer/index.tsx', 'bottomPlaceholderHeight', 'virtualized bottom spacer');

console.log('[message-protocol] all assertions passed');
