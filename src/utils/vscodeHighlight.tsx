import type { ReactNode } from 'react';

const CONTROL_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'as',
  'default',
  'return',
  'if',
  'else',
  'switch',
  'case',
  'break',
  'continue',
  'for',
  'while',
  'do',
  'try',
  'catch',
  'finally',
  'throw',
  'await',
  'async',
  'yield',
]);

const DECL_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'extends',
  'implements',
  'new',
  'typeof',
  'keyof',
  'in',
  'of',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'this',
  'super',
  'number',
  'string',
  'boolean',
  'unknown',
  'never',
  'any',
  'object',
]);

const TOKEN_RE =
  /(\/\/.*$|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

export function renderHighlightedLine(line: string): ReactNode {
  if (!line) return ' ';

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++} className="text-[#d4d4d4]">
          {line.slice(lastIndex, match.index)}
        </span>
      );
    }

    const token = match[0];
    const afterChar = line[match.index + token.length] ?? '';
    let colorClass = 'text-[#9cdcfe]';

    if (token.startsWith('//') || token.startsWith('/*')) {
      colorClass = 'text-[#6a9955] italic';
    } else if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) {
      colorClass = 'text-[#ce9178]';
    } else if (/^\d/.test(token)) {
      colorClass = 'text-[#b5cea8]';
    } else if (CONTROL_KEYWORDS.has(token)) {
      colorClass = 'text-[#c586c0]';
    } else if (DECL_KEYWORDS.has(token)) {
      colorClass = 'text-[#569cd6]';
    } else if (afterChar === '(') {
      colorClass = 'text-[#dcdcaa]';
    } else if (/^[A-Z]/.test(token)) {
      colorClass = 'text-[#4ec9b0]';
    }

    parts.push(
      <span key={key++} className={colorClass}>
        {token}
      </span>
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < line.length) {
    parts.push(
      <span key={key++} className="text-[#d4d4d4]">
        {line.slice(lastIndex)}
      </span>
    );
  }

  return parts.length > 0 ? parts : ' ';
}
