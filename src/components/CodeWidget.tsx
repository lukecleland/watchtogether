import { useEffect, useRef } from 'react';
import type { CodeContent } from '../types/panels';
import { formatCode } from '../utils/code';
import { DockButton } from './Dock';

interface CodeWidgetProps {
	code: CodeContent;
	onChange: (code: CodeContent) => void;
	onClose?: () => void;
	docked?: boolean;
	onToggleDock?: () => void;
	embedded?: boolean;
}

export function CodeWidget({ code, onChange, onClose, docked = false, onToggleDock, embedded = false }: CodeWidgetProps) {
	const editorRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const editor = editorRef.current;
		if (editor && editor.value !== code.text && document.activeElement !== editor) editor.value = code.text;
	}, [code.text]);

	return (
		<div data-code-widget className={`flex h-full min-h-0 flex-col overflow-hidden ${embedded ? 'rounded-lg border border-black/20 bg-zinc-950' : 'rounded-xl border border-zinc-700 bg-zinc-950 shadow-xl'}`}>
			<div className={`${embedded ? 'no-drag' : 'drag-handle cursor-grab active:cursor-grabbing'} flex shrink-0 items-center justify-between bg-zinc-900 px-2 py-1.5 text-zinc-300`}>
				<select value={code.language} onChange={e => onChange({ ...code, language: e.target.value })} className="no-drag rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] outline-none">
					{['text', 'javascript', 'typescript', 'json', 'html', 'css', 'python', 'sql', 'code'].map(language => <option key={language}>{language}</option>)}
				</select>
				<div className="flex items-center gap-1">
					<button className="no-drag rounded px-1.5 py-0.5 text-[11px] hover:bg-zinc-700" onClick={() => onChange({ ...code, text: formatCode(code) })}>Format</button>
					{onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
					{onClose && <button className="no-drag px-1 text-zinc-400 hover:text-white" onClick={onClose} aria-label="Close code widget">×</button>}
				</div>
			</div>
			<textarea
				ref={editorRef}
				data-code-editor
				defaultValue={code.text}
				onChange={e => onChange({ ...code, text: e.target.value })}
				onKeyDown={e => {
					if (e.key !== 'Tab') return;
					e.preventDefault();
					const el = e.currentTarget;
					const next = `${el.value.slice(0, el.selectionStart)}  ${el.value.slice(el.selectionEnd)}`;
					const caret = el.selectionStart + 2;
					el.value = next;
					el.setSelectionRange(caret, caret);
					onChange({ ...code, text: next });
				}}
				spellCheck={false}
				placeholder="Paste or write code…"
				className="no-drag min-h-0 flex-1 resize-none bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-emerald-200 outline-none placeholder:text-zinc-600"
			/>
		</div>
	);
}
