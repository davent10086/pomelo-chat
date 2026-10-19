import { useEffect, useRef, useState, type DragEvent } from 'react';

const hasFiles = (transfer: DataTransfer | null) => Boolean(transfer && Array.from(transfer.types).includes('Files'));

/** Prevent browser navigation for files, while leaving text selection/dragging alone. */
export function useFileDrop(scope: string | undefined, onFiles: (files: File[]) => void, onError: (message: string) => void) {
	const [active, setActive] = useState(false);
	const depth = useRef(0);
	const reset = () => { depth.current = 0; setActive(false); };
	useEffect(() => {
		depth.current = 0; setActive(false);
	}, [scope]);
	useEffect(() => {
		const prevent = (event: globalThis.DragEvent) => {
			if (hasFiles(event.dataTransfer)) event.preventDefault();
			if (event.type === 'drop') reset();
		};
		document.addEventListener('dragover', prevent);
		document.addEventListener('drop', prevent);
		window.addEventListener('blur', reset);
		window.addEventListener('dragend', reset);
		return () => {
			document.removeEventListener('dragover', prevent);
			document.removeEventListener('drop', prevent);
			window.removeEventListener('blur', reset);
			window.removeEventListener('dragend', reset);
		};
	}, []);
	return {
		active,
		handlers: {
			onDragEnter(event: DragEvent) {
				if (!hasFiles(event.dataTransfer)) return;
				event.preventDefault(); depth.current++;
				if (scope) setActive(true);
			},
			onDragOver(event: DragEvent) {
				if (!hasFiles(event.dataTransfer)) return;
				event.preventDefault(); event.dataTransfer.dropEffect = scope ? 'copy' : 'none';
			},
			onDragLeave(event: DragEvent) {
				if (!hasFiles(event.dataTransfer)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (!depth.current) setActive(false);
			},
			onDrop(event: DragEvent) {
				if (!hasFiles(event.dataTransfer)) return;
				event.preventDefault(); reset();
				if (!scope) { onError('请在私聊或群聊中发送文件'); return; }
				const items = Array.from(event.dataTransfer.items);
				if (items.some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {
					onError('暂不支持拖拽文件夹，请选择文件'); return;
				}
				const files = Array.from(event.dataTransfer.files);
				if (files.length) onFiles(files);
			}
		}
	};
}
