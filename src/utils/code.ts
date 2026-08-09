import type { CodeContent } from '../types/panels';

export function detectCodeLanguage(text: string): string | null {
	const value = text.trim();
	if (!value || !value.includes('\n')) return null;

	try {
		const parsed = JSON.parse(value);
		if (parsed !== null && typeof parsed === 'object') return 'json';
	} catch { /* not JSON */ }

	if (/^\s*<\/?[a-z][\s\S]*>\s*$/i.test(value)) return 'html';
	if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b[\s\S]+\b(FROM|INTO|TABLE|SET)\b/im.test(value)) return 'sql';
	if (/^\s*(def |class |from \S+ import |import \S+|if __name__)/m.test(value) || /:\s*\n\s{2,}\S/.test(value)) return 'python';
	if (/\b(const|let|var|function|interface|type|export|import)\b/.test(value) && /[;{}]|=>/.test(value)) {
		return /\b(interface|type)\s+\w+|:\s*(string|number|boolean)\b/.test(value) ? 'typescript' : 'javascript';
	}
	if (/^\s*(package |func |class |public |private |#include|using namespace)/m.test(value) && /[;{}]/.test(value)) return 'code';
	if (/^[\s\S]*[{[]\s*$/.test(value) && /[}\]]\s*$/.test(value) && /[;:=]/.test(value)) return 'code';
	return null;
}

export function codeFromText(text: string): CodeContent | null {
	const language = detectCodeLanguage(text);
	return language ? { text: text.trim(), language } : null;
}

export function formatCode(content: CodeContent): string {
	const source = content.text.trim();
	if (!source) return '';
	if (content.language === 'json') {
		try { return JSON.stringify(JSON.parse(source), null, 2); } catch { return content.text; }
	}

	// A deliberately small, safe formatter for brace-based snippets. It leaves
	// Python, SQL and unknown formats untouched rather than damaging valid code.
	if (!['javascript', 'typescript', 'code'].includes(content.language)) return content.text;
	let depth = 0;
	return source.split('\n').map(line => {
		const trimmed = line.trim();
		if (/^[}\]]/.test(trimmed)) depth = Math.max(0, depth - 1);
		const formatted = `${'  '.repeat(depth)}${trimmed}`;
		if (/[{[]\s*$/.test(trimmed) && !/^[}\]]/.test(trimmed)) depth++;
		return formatted;
	}).join('\n');
}
