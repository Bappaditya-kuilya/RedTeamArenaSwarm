import type { CodeDiagnostic } from '../types/ide';

interface BugRule {
  code: string;
  title: string;
  severity: 'error' | 'warning';
  pattern: RegExp;
  exclude?: RegExp;
  explanation: string;
  fixLine: (line: string, prevLine?: string) => string | undefined;
}

const BUG_RULES: BugRule[] = [
  {
    code: 'BUG-EMPTY-CATCH',
    title: 'Silent empty catch block swallows runtime exceptions',
    severity: 'warning',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    explanation:
      'Swallowing exceptions in an empty catch block hides root causes during failures. Log or surface the error explicitly.',
    fixLine: (line) =>
      line.replace(
        /catch\s*(\([^)]*\))?\s*\{\s*\}/,
        (_, errParam) =>
          `catch ${errParam || '(err)'} { console.error('Unhandled error:', ${
            errParam ? errParam.replace(/[()]/g, '').split(':')[0].trim() || 'err' : 'err'
          }); }`
      ),
  },
  {
    code: 'BUG-PARSEINT-RADIX',
    title: 'parseInt() called without explicit base-10 radix',
    severity: 'warning',
    pattern: /\bparseInt\s*\(\s*[^,)]+\s*\)/,
    explanation:
      'Calling parseInt() without a radix risks misparsing octal/hex strings in edge cases. Always specify radix 10.',
    fixLine: (line) => line.replace(/\bparseInt\s*\(\s*([^,)]+)\s*\)/g, 'parseInt($1, 10)'),
  },
  {
    code: 'BUG-LOOSE-EQ',
    title: 'Loose equality operator (== or !=) risks type coercion bugs',
    severity: 'warning',
    pattern: /(?:[^!=<>]|^)(?:==|!=)(?:[^=]|$)/,
    exclude: /===\s*|!==\s*|==\s*null|!=\s*null|['"`].*(?:==|!=).*['"`]/,
    explanation:
      'Loose equality performs implicit type coercion (e.g. "" == 0 is true). Prefer strict === or !==.',
    fixLine: (line) =>
      line
        .replace(/([^!=<>])===?/g, '$1===')
        .replace(/([^!])!==?/g, '$1!==')
        .replace(/====/g, '===')
        .replace(/!===/g, '!=='),
  },
  {
    code: 'BUG-TABNABBING',
    title: 'target="_blank" anchor missing rel="noopener noreferrer"',
    severity: 'warning',
    pattern: /target\s*=\s*['"]_blank['"]/,
    exclude: /noopener/,
    explanation:
      'Opening external links with target="_blank" without rel="noopener noreferrer" exposes window.opener and leaks process resources.',
    fixLine: (line) =>
      line.replace(/target\s*=\s*(['"])_blank\1/, 'target=$1_blank$1 rel="noopener noreferrer"'),
  },
  {
    code: 'BUG-THROW-LITERAL',
    title: 'Throwing non-Error primitive loses stack trace',
    severity: 'error',
    pattern: /\bthrow\s+['"`][^'"`]+['"`]/,
    explanation:
      'Throwing a string literal instead of an Error instance omits stack traces and breaks instanceof Error handlers.',
    fixLine: (line) => line.replace(/\bthrow\s+(['"`][^'"`]+['"`])/, 'throw new Error($1)'),
  },
  {
    code: 'BUG-DEBUGGER-STMT',
    title: 'Leftover debugger statement halts execution in DevTools',
    severity: 'error',
    pattern: /^\s*debugger\s*;?\s*$/,
    explanation: 'Remove stray debugger breakpoints before shipping code.',
    fixLine: () => '// removed leftover debugger breakpoint',
  },
  {
    code: 'BUG-UNSAFE-JSON-PARSE',
    title: 'JSON.parse() without surrounding try/catch guard',
    severity: 'warning',
    pattern: /\bJSON\.parse\s*\(/,
    explanation:
      'Malformed input causes JSON.parse() to throw a synchronous SyntaxError that can crash request handlers.',
    fixLine: (line, prevLine) => {
      if (prevLine && /\btry\s*\{/.test(prevLine)) return undefined;
      if (/=\s*JSON\.parse\s*\(/.test(line)) {
        return line.replace(
          /JSON\.parse\s*\(([^)]+)\)/,
          '(() => { try { return JSON.parse($1); } catch { return null; } })()'
        );
      }
      return undefined;
    },
  },
];

export function analyzeBugsInCode(
  code: string,
  filePath: string
): CodeDiagnostic[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'html'].includes(ext)) {
    return [];
  }

  const lines = code.split(/\r?\n/);
  const diagnostics: CodeDiagnostic[] = [];
  let count = 1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    const windowBefore = lines.slice(Math.max(0, i - 3), i).join('\n');

    for (const rule of BUG_RULES) {
      if (rule.exclude && rule.exclude.test(rawLine)) continue;
      if (
        rule.code === 'BUG-UNSAFE-JSON-PARSE' &&
        (/\btry\s*\{/.test(windowBefore) || /\btry\s*\{/.test(rawLine))
      ) {
        continue;
      }

      const match = rule.pattern.exec(rawLine);
      if (!match) continue;

      const patch = rule.fixLine(rawLine, lines[i - 1]);
      diagnostics.push({
        id: `bug-${filePath}-${i + 1}-${count++}`,
        source: 'bug',
        severity: rule.severity,
        code: rule.code,
        filePath,
        line: i + 1,
        column: (match.index ?? 0) + 1,
        title: rule.title,
        message: `${rule.title} at ${filePath}:${i + 1}`,
        agentId: 'subagent-bug',
        agentName: 'Bug · Logic-Debugger',
        agentColor: '#FF8A00',
        originalLine: rawLine,
        suggestedLinePatch: patch !== rawLine ? patch : undefined,
        explanation: rule.explanation,
        fixed: false,
      });
    }
  }

  return diagnostics;
}

function isCommentOnlyPatch(patch: string): boolean {
  const t = patch.trim();
  return (
    t.startsWith('//') ||
    /^\/\*[\s\S]*\*\/$/.test(t)
  );
}

function isAutoApplicableSuggestedPatch(patch: string | undefined): patch is string {
  if (!patch) return false;
  if (patch.includes('\n')) return false;
  if (isCommentOnlyPatch(patch)) return false;
  if (/TODO|FIXME|hardened|verify outbound URL host allowlist/i.test(patch) && /\/[/*]/.test(patch)) {
    return false;
  }
  return true;
}

export function applyDiagnosticFixToContent(
  content: string,
  diagnostic: CodeDiagnostic
): string {
  if (diagnostic.suggestedFilePatch) {
    return diagnostic.suggestedFilePatch !== content ? diagnostic.suggestedFilePatch : content;
  }
  if (!isAutoApplicableSuggestedPatch(diagnostic.suggestedLinePatch)) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const idx = diagnostic.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return content;
  }

  if (diagnostic.originalLine != null && lines[idx] !== diagnostic.originalLine) {
    return content;
  }

  const rule = BUG_RULES.find((r) => r.code === diagnostic.code);
  if (rule) {
    const composed = rule.fixLine(lines[idx], lines[idx - 1]);
    if (composed && composed !== lines[idx] && isAutoApplicableSuggestedPatch(composed)) {
      lines[idx] = composed;
      return lines.join('\n');
    }
  }

  if (diagnostic.suggestedLinePatch === lines[idx]) {
    return content;
  }
  lines[idx] = diagnostic.suggestedLinePatch;
  return lines.join('\n');
}

export function applyAllFixesToFiles(
  fileContents: Record<string, string>,
  diagnostics: CodeDiagnostic[]
): { updatedFiles: Record<string, string>; appliedIds: Set<string> } {
  const updatedFiles: Record<string, string> = { ...fileContents };
  const appliedIds = new Set<string>();

  // Group fixes per file; apply line fixes in descending order. If a line changes, skip other
  // diagnostics targeting the same original line snapshot (originalLine check prevents stale applies).
  const byFile = new Map<string, CodeDiagnostic[]>();
  for (const diag of diagnostics) {
    if (diag.fixed) continue;
    if (!diag.suggestedFilePatch && !diag.suggestedLinePatch) continue;
    const list = byFile.get(diag.filePath) ?? [];
    list.push(diag);
    byFile.set(diag.filePath, list);
  }

  for (const [filePath, list] of byFile.entries()) {
    let content = updatedFiles[filePath];
    if (content === undefined) continue;

    const fullFileDiag = list.find(
      (d) => d.suggestedFilePatch && d.suggestedFilePatch !== content
    );
    if (fullFileDiag?.suggestedFilePatch) {
      updatedFiles[filePath] = fullFileDiag.suggestedFilePatch;
      // Only mark the diagnostic whose patch was actually applied; others may not be covered.
      appliedIds.add(fullFileDiag.id);
      continue;
    }

    const sorted = [...list].sort((a, b) => b.line - a.line || a.id.localeCompare(b.id));
    const changedLines = new Set<number>();
    for (const diag of sorted) {
      // Avoid compounding multiple patches on the same physical line in one pass.
      if (changedLines.has(diag.line)) continue;
      const next = applyDiagnosticFixToContent(content, diag);
      if (next !== content) {
        content = next;
        appliedIds.add(diag.id);
        changedLines.add(diag.line);
      }
    }
    updatedFiles[filePath] = content;
  }

  return { updatedFiles, appliedIds };
}
