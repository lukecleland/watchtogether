import type { CodeContent } from '../types/panels';

let pythonFormatter: Promise<(source: string) => string> | null = null;

function getPythonFormatter(): Promise<(source: string) => string> {
	pythonFormatter ??= import('@astral-sh/ruff-wasm-web').then(async ruff => {
		await ruff.default();
		const workspace = new ruff.Workspace(
			{ 'line-length': 88, 'indent-width': 4, format: { 'indent-style': 'space', 'quote-style': 'double' } },
			ruff.PositionEncoding.Utf16
		);
		return source => workspace.format(source);
	});
	return pythonFormatter;
}

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

export function canFormatLanguage(language: string): boolean {
	return ['javascript', 'typescript', 'json', 'html', 'css', 'python', 'sql'].includes(language);
}

/** Format with the parser belonging to the selected language. Imports stay
 * lazy so opening a room does not download every formatter up front. */
export async function formatCode(content: CodeContent): Promise<string> {
	const source = content.text.trim();
	if (!source) return '';

	if (content.language === 'sql') {
		const { format } = await import('sql-formatter');
		return format(source, { language: 'sql', tabWidth: 2, keywordCase: 'upper' });
	}

	if (content.language === 'python') {
		return (await getPythonFormatter())(source);
	}

	const prettier = await import('prettier/standalone');
	const estree = await import('prettier/plugins/estree');
	const parser = content.language === 'javascript' ? 'babel' : content.language;
	const syntaxPlugin =
		content.language === 'typescript'
			? await import('prettier/plugins/typescript')
			: content.language === 'html'
				? await import('prettier/plugins/html')
				: content.language === 'css'
					? await import('prettier/plugins/postcss')
					: await import('prettier/plugins/babel');

	return prettier.format(source, {
		parser,
		plugins: [syntaxPlugin, estree],
		tabWidth: 2,
		useTabs: false,
		semi: true,
		singleQuote: true
	});
}
