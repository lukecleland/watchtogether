import { useMemo, useRef, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-sql';
import type { CodeContent } from '../types/panels';
import { canFormatLanguage, formatCode } from '../utils/code';
import { DockButton } from './Dock';

interface CodeWidgetProps {
	code: CodeContent;
	onChange: (code: CodeContent) => void;
	onClose?: () => void;
	docked?: boolean;
	onToggleDock?: () => void;
	embedded?: boolean;
	title?: string;
}

export function CodeWidget({ code, onChange, onClose, docked = false, onToggleDock, embedded = false, title = 'Code' }: CodeWidgetProps) {
	const editorRef = useRef<HTMLTextAreaElement>(null);
	const highlightRef = useRef<HTMLPreElement>(null);
	const [isFormatting, setIsFormatting] = useState(false);
	const [formatError, setFormatError] = useState<string | null>(null);
	const grammarName = code.language === 'html' ? 'markup' : code.language === 'code' ? 'javascript' : code.language;
	const highlighted = useMemo(() => {
		const grammar = Prism.languages[grammarName];
		return grammar ? Prism.highlight(code.text, grammar, grammarName) : null;
	}, [code.text, grammarName]);

	const syncScroll = () => {
		const editor = editorRef.current;
		const highlight = highlightRef.current;
		if (!editor || !highlight) return;
		highlight.scrollTop = editor.scrollTop;
		highlight.scrollLeft = editor.scrollLeft;
	};

	const runFormatter = async () => {
		if (!canFormatLanguage(code.language) || !code.text.trim()) return;
		setIsFormatting(true);
		setFormatError(null);
		try {
			onChange({ ...code, text: await formatCode(code) });
		} catch (error) {
			setFormatError(error instanceof Error ? error.message : 'Could not format this code');
		} finally {
			setIsFormatting(false);
		}
	};

	return (
		<div data-code-widget className={`flex h-full min-h-0 flex-col overflow-hidden ${embedded ? 'rounded-lg border border-black/20 bg-zinc-950' : 'rounded-xl border border-zinc-700 bg-zinc-950 shadow-xl'}`}>
			<div className={`${embedded ? 'no-drag' : 'drag-handle cursor-grab active:cursor-grabbing'} flex shrink-0 items-center justify-between bg-zinc-900 px-2 py-1.5 text-zinc-300`}>
				<div className="flex min-w-0 items-center gap-2"><span className="max-w-28 truncate text-xs font-semibold">{title}</span><select value={code.language} onChange={e => { setFormatError(null); onChange({ ...code, language: e.target.value }); }} className="no-drag rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] outline-none">
					{['text', 'javascript', 'typescript', 'json', 'html', 'css', 'python', 'sql', 'code'].map(language => <option key={language} value={language}>{language === 'text' ? 'Plain text' : language === 'code' ? 'Generic code' : language[0].toUpperCase() + language.slice(1)}</option>)}
				</select></div>
				<div className="flex items-center gap-1">
					<button disabled={!canFormatLanguage(code.language) || !code.text.trim() || isFormatting} title={canFormatLanguage(code.language) ? `Format as ${code.language}` : 'Choose a specific language to format'} className="no-drag rounded px-1.5 py-0.5 text-[11px] hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void runFormatter()}>{isFormatting ? 'Formatting…' : 'Format'}</button>
					{onToggleDock && <DockButton docked={docked} onToggle={onToggleDock} />}
					{onClose && <button className="no-drag px-1 text-zinc-400 hover:text-white" onClick={onClose} aria-label="Close code widget">×</button>}
				</div>
			</div>
			{formatError && <div role="alert" className="no-drag shrink-0 border-t border-red-900/60 bg-red-950/70 px-2 py-1 text-[10px] text-red-300" title={formatError}>Format failed: check that the code is valid {code.language}.</div>}
			<div className="no-drag relative min-h-0 flex-1 overflow-hidden bg-zinc-950">
			<pre ref={highlightRef} aria-hidden="true" className="code-highlight pointer-events-none absolute inset-0 overflow-hidden whitespace-pre p-3 font-mono text-xs leading-relaxed"><code dangerouslySetInnerHTML={highlighted === null ? undefined : { __html: `${highlighted}\n` }}>{highlighted === null ? `${code.text}\n` : undefined}</code></pre>
			<textarea
				ref={editorRef}
				data-code-editor
				value={code.text}
				onChange={e => onChange({ ...code, text: e.target.value })}
				onScroll={syncScroll}
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
				className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent p-3 font-mono text-xs leading-relaxed text-transparent caret-white outline-none selection:bg-violet-500/40 placeholder:text-zinc-600"
			/>
			</div>
		</div>
	);
}
