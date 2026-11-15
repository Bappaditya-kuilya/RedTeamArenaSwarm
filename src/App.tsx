import { useCallback, useEffect, useRef, useState } from 'react';
import { IdeDebuggerView } from './components/IdeDebuggerView';
import { SWARM_CURSOR_PROFILES } from './engine/swarmProfiles';
import { applyAllFixesToFiles, applyDiagnosticFixToContent } from './engine/bugAnalyzer';
import type {
  ApplyFixResponse,
  CodeDiagnostic,
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  DebugRunResponse,
  DiagnosticVerificationStatus,
  GitFileStatus,
  RepoFileNode,
  SwarmStreamEvent,
  WorkspaceSnapshot,
} from './types/ide';

function buildIdleAgents(count: number): CursorAgentState[] {
  return Array.from({ length: count }, (_, idx) => {
    const profile = SWARM_CURSOR_PROFILES[idx % SWARM_CURSOR_PROFILES.length];
    return {
      id: profile.id,
      name: `Cursor ${idx + 1}`,
      color: profile.color,
      status: 'idle',
      filePath: null,
      line: 1,
      column: 1,
      task: 'Ready',
      diagnosticId: null,
      fixedCount: 0,
      createdCount: 0,
    };
  });
}

function pickInitialFiles(snapshot: WorkspaceSnapshot): { primary: string; secondary: string } {
  const codeFiles = snapshot.files.filter((f) => /\.(ts|tsx|js|jsx)$/i.test(f.path));
  const primary =
    codeFiles.find((f) => /^(src\/|server\/)/i.test(f.path) && !/\.(test|spec)\./i.test(f.path))
      ?.path ??
    codeFiles[0]?.path ??
    snapshot.files[0]?.path ??
    '';

  const secondary =
    codeFiles.find((f) => f.path !== primary && /\.(test|spec)\./i.test(f.path))?.path ??
    codeFiles.find((f) => f.path !== primary)?.path ??
    primary;

  return { primary, secondary };
}

function diagKey(d: Pick<CodeDiagnostic, 'source' | 'code' | 'filePath' | 'line' | 'title' | 'message'>): string {
  return [d.source, d.code, d.filePath, d.line, d.title, d.message].join('|');
}

async function safeReadJson<T>(resp: Response): Promise<T | null> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
    case 'scss':
      return 'css';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'md':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return 'text';
  }
}

function buildClientDemoSnapshot(): WorkspaceSnapshot {
  const demoFiles: Array<{ path: string; content: string }> = [
    {
      path: 'package.json',
      content: JSON.stringify(
        { name: 'billing-service-sandbox', version: '1.0.0', type: 'module' },
        null,
        2
      ),
    },
    {
      path: 'src/pricing.ts',
      content: [
        'export function calculateInvoiceTotal(rawQty: string, unitPrice: number): number {',
        "  const taxRate: number = '0.08';",
        '  const qty = parseInt(rawQty);',
        '  if (qty == 0) throw "Quantity must be positive";',
        '  return Number((qty * unitPrice * (1 + taxRate)).toFixed(2));',
        '}',
        '',
        'export function formatCurrencyCents(centsInput: string): string {',
        '  const cents = parseInt(centsInput);',
        '  if (Number.isNaN(cents)) {',
        '    throw "Invalid cents value";',
        '  }',
        '  return `$${(cents / 100).toFixed(2)}`;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/pricing.test.ts',
      content: [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { calculateInvoiceTotal, formatCurrencyCents } from './pricing.ts';",
        '',
        "test('calculateInvoiceTotal computes qty * unitPrice with 8% tax', () => {",
        "  assert.equal(calculateInvoiceTotal('2', 50), 108);",
        '});',
        '',
        "test('formatCurrencyCents formats USD dollars accurately', () => {",
        "  assert.equal(formatCurrencyCents('1250'), '$12.50');",
        '});',
        '',
      ].join('\n'),
    },
    {
      path: 'src/users.ts',
      content: [
        'export interface DbClient {',
        '  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;',
        '}',
        '',
        'export async function findUserByEmail(db: DbClient, email: string) {',
        '  const rows = await db.query("SELECT id, email FROM users WHERE email = " + email);',
        '  return rows[0] ?? null;',
        '}',
        '',
        'export function parseUserMetadata(rawJson: string): Record<string, unknown> | null {',
        '  const parsed = JSON.parse(rawJson);',
        '  try {',
        '    if (parsed == null) return null;',
        '    return parsed as Record<string, unknown>;',
        '  } catch (err) {}',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/render.ts',
      content: [
        'export function renderProfileCard(container: { textContent: string | null; innerHTML: string }, bio: string) {',
        '  debugger;',
        '  container.innerHTML = bio;',
        '}',
        '',
        'export function externalLinkMarkup(url: string, label: string): string {',
        '  const safeHref: string = 404;',
        '  void safeHref;',
        '  return `<a href="${url}" target="_blank">${label}</a>`;',
        '}',
        '',
      ].join('\n'),
    },
  ];

  const fileContents: Record<string, string> = {};
  const files: RepoFileNode[] = demoFiles.map((f) => {
    fileContents[f.path] = f.content;
    return {
      path: f.path,
      name: f.path.split('/').pop() ?? f.path,
      language: inferLanguage(f.path),
      size: f.content.length,
      lineCount: f.content.split('\n').length,
      diagnosticCount: 0,
    };
  });

  return {
    workspaceId: 'demo-showcase',
    repoName: 'demo/billing-ts-service',
    repoUrl: 'local://demo-billing-ts',
    sourceType: 'demo',
    branch: 'main',
    files,
    fileContents,
    fileStatuses: {},
  };
}

function buildShowcaseDemoScanResult(ws: WorkspaceSnapshot): DebugRunResponse {
  const now = 18;
  const mkDiag = (d: Partial<CodeDiagnostic> & Pick<CodeDiagnostic, 'id' | 'filePath' | 'line' | 'code' | 'title' | 'message' | 'source' | 'severity' | 'explanation'>): CodeDiagnostic => ({
    column: 1,
    agentId: 'subagent-sec',
    agentName: 'Security/Bug Subagent',
    agentColor: '#f59e0b',
    fixed: false,
    verified: false,
    verificationStatus: 'open',
    provenance: `demo:${d.source} ${d.filePath}:${d.line} [${d.code}]`,
    evidence: [d.explanation],
    ...d,
  });
  const contents = ws.fileContents ?? {};
  const present = (id: string, filePath: string, needle: string) => {
    const c = contents[filePath] ?? '';
    return c.includes(needle);
  };

  const diagnostics: CodeDiagnostic[] = [];
  if (present('demo-1', 'src/pricing.ts', "const taxRate: number = '0.08';")) {
    diagnostics.push(mkDiag({
      id: 'demo-1', filePath: 'src/pricing.ts', line: 2, column: 27, code: 'TS2322',
      title: 'Type mismatch', message: "Type 'string' is not assignable to type 'number' (taxRate).",
      source: 'typescript', severity: 'error', agentId: 'subagent-tsc', agentName: 'TSC Subagent', agentColor: '#3b82f6',
      explanation: 'taxRate is typed as number but assigned a string literal.',
      originalLine: "  const taxRate: number = '0.08';",
      suggestedLinePatch: '  const taxRate = 0.08;',
    }));
  }
  if (present('demo-2', 'src/pricing.ts', 'const qty = parseInt(rawQty);')) {
    diagnostics.push(mkDiag({
      id: 'demo-2', filePath: 'src/pricing.ts', line: 3, column: 15, code: 'BUG-PARSEINT-RADIX',
      title: 'parseInt without radix', message: 'parseInt called without radix; may parse unexpectedly.',
      source: 'bug', severity: 'warning', agentId: 'subagent-bug', agentName: 'Bug Subagent', agentColor: '#8b5cf6',
      explanation: 'Use parseInt(rawQty, 10) for deterministic parsing.',
      originalLine: '  const qty = parseInt(rawQty);',
      suggestedLinePatch: '  const qty = parseInt(rawQty, 10);',
    }));
  }
  if (present('demo-3', 'src/pricing.ts', 'if (qty == 0) throw "Quantity must be positive";')) {
    diagnostics.push(mkDiag({
      id: 'demo-3', filePath: 'src/pricing.ts', line: 4, column: 11, code: 'BUG-LOOSE-EQ',
      title: 'Loose equality / thrown string', message: 'Use strict equality and throw Error instances.',
      source: 'bug', severity: 'warning', agentId: 'subagent-bug', agentName: 'Bug Subagent', agentColor: '#8b5cf6',
      explanation: 'Loose equality can coerce types; throwing strings loses stack traces.',
      originalLine: '  if (qty == 0) throw "Quantity must be positive";',
      suggestedLinePatch: '  if (qty === 0) throw new Error("Quantity must be positive");',
    }));
  }
  if (present('demo-4', 'src/users.ts', 'const rows = await db.query("SELECT id, email FROM users WHERE email = " + email);')) {
    diagnostics.push(mkDiag({
      id: 'demo-4', filePath: 'src/users.ts', line: 6, column: 29, code: 'sql-injection',
      title: 'Possible SQL injection', message: 'User input concatenated directly into SQL query.',
      source: 'security', severity: 'error', agentId: 'subagent-sec', agentName: 'Security Subagent', agentColor: '#f59e0b',
      explanation: 'Use parameterized queries/placeholders instead of string concatenation.',
      originalLine: '  const rows = await db.query("SELECT id, email FROM users WHERE email = " + email);',
      suggestedLinePatch: '  const rows = await db.query("SELECT id, email FROM users WHERE email = ?", [email]);',
    }));
  }
  const usersUnfixed = present('demo-5', 'src/users.ts', '  const parsed = JSON.parse(rawJson);') && present('demo-5', 'src/users.ts', '  try {');
  if (usersUnfixed) {
    diagnostics.push(mkDiag({
      id: 'demo-5', filePath: 'src/users.ts', line: 11, column: 1, code: 'unreachable-catch',
      title: 'Unsafe JSON parse structure', message: 'JSON.parse is outside try/catch; parse failures are not handled safely.',
      source: 'bug', severity: 'warning', agentId: 'subagent-bug', agentName: 'Bug Subagent', agentColor: '#8b5cf6',
      explanation: 'JSON.parse should be inside try/catch to handle invalid input safely.',
      suggestedFilePatch: [
        'export interface DbClient {',
        '  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;',
        '}',
        '',
        'export async function findUserByEmail(db: DbClient, email: string) {',
        '  const rows = await db.query("SELECT id, email FROM users WHERE email = ?", [email]);',
        '  return rows[0] ?? null;',
        '}',
        '',
        'export function parseUserMetadata(rawJson: string): Record<string, unknown> | null {',
        '  try {',
        '    const parsed = JSON.parse(rawJson);',
        '    if (parsed == null) return null;',
        '    return parsed as Record<string, unknown>;',
        '  } catch {',
        '    return null;',
        '  }',
        '}',
        '',
      ].join('\n'),
    }));
  }
  if (present('demo-6', 'src/render.ts', '  debugger;')) {
    diagnostics.push(mkDiag({
      id: 'demo-6', filePath: 'src/render.ts', line: 2, column: 3, code: 'BUG-DEBUGGER-STMT',
      title: 'Debugger statement', message: 'Unexpected debugger statement in source.',
      source: 'bug', severity: 'warning', agentId: 'subagent-bug', agentName: 'Bug Subagent', agentColor: '#8b5cf6',
      explanation: 'Remove debugger statements before shipping.',
      originalLine: '  debugger;',
      suggestedLinePatch: '  // removed leftover debugger breakpoint',
    }));
  }
  if (present('demo-7', 'src/render.ts', '  container.innerHTML = bio;')) {
    diagnostics.push(mkDiag({
      id: 'demo-7', filePath: 'src/render.ts', line: 3, column: 13, code: 'xss-innerHTML',
      title: 'Potential XSS sink', message: 'Assigning untrusted content to innerHTML can enable XSS.',
      source: 'security', severity: 'error', agentId: 'subagent-sec', agentName: 'Security Subagent', agentColor: '#f59e0b',
      explanation: 'Prefer textContent or sanitize/escape untrusted HTML.',
      originalLine: '  container.innerHTML = bio;',
      suggestedLinePatch: '  container.textContent = bio;',
    }));
  }

  return {
    workspaceId: ws.workspaceId,
    subagents: [
      { id: 'subagent-tsc', name: 'TSC Subagent', specialty: 'TypeScript', color: '#3b82f6', status: 'done', elapsedMs: now, findingsCount: diagnostics.filter(d => d.source === 'typescript').length, summary: diagnostics.length ? 'Analyzed demo workspace (showcase).' : 'No type issues detected in showcase demo.' },
      { id: 'subagent-sec', name: 'Security Subagent', specialty: 'Security', color: '#f59e0b', status: 'done', elapsedMs: now, findingsCount: diagnostics.filter(d => d.source === 'security').length, summary: diagnostics.some(d=>d.source==='security') ? 'Detected risky SQL/DOM patterns (showcase).' : 'No security issues detected in showcase demo.' },
      { id: 'subagent-bug', name: 'Bug Subagent', specialty: 'Bug patterns', color: '#8b5cf6', status: 'done', elapsedMs: now, findingsCount: diagnostics.filter(d => d.source === 'bug').length, summary: diagnostics.some(d=>d.source==='bug') ? 'Detected correctness and hygiene issues (showcase).' : 'No bug-pattern issues detected in showcase demo.' },
    ],
    diagnostics,
    tscResult: { ran: false, filesChecked: 5, errorCount: diagnostics.filter(d => d.severity === 'error' && d.source === 'typescript').length, warningCount: 0, durationMs: now, output: 'Showcase mode: backend unavailable (static deploy). Displaying sample diagnostics for demo.' },
    testResult: { ran: false, command: 'node --test', exitCode: 0, durationMs: 0, passed: 0, failed: 0, skipped: 0, output: 'Showcase mode: tests not executed without backend.' },
    terminalLines: [
      '[showcase] Running without backend API; local demo workspace.',
      '[showcase] Real clone/tsc/tests/git/fix require a Node server deployment.',
    ],
    gitDiff: computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, contents),
    fileStatuses: ws.fileStatuses ?? {},
    totalElapsedMs: 42,
    scanEvidence: { source: 'real-debug-endpoint', coverage: { tsc: false, tests: false, security: true, bug: true, ai: false } },
  };
}


function isShowcaseWs(ws: WorkspaceSnapshot | null | undefined): boolean {
  return Boolean(ws && (ws.sourceType === 'demo' || ws.workspaceId === 'demo-showcase' || ws.workspaceId === 'custom-showcase'));
}

function simpleUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const lines: string[] = [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`, '@@'];
  for (const l of a) lines.push(`-${l}`);
  for (const l of b) lines.push(`+${l}`);
  return lines.join('\n');
}

function computeShowcaseGitDiff(oldContents: Record<string, string>, newContents: Record<string, string>): string {
  const paths = Array.from(new Set([...Object.keys(oldContents), ...Object.keys(newContents)])).sort();
  return paths
    .map((p) => simpleUnifiedDiff(oldContents[p] ?? '', newContents[p] ?? '', p))
    .filter(Boolean)
    .join('\n\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withScanEvidence(result: DebugRunResponse): DebugRunResponse {
  return {
    ...result,
    scanEvidence: {
      source: 'real-debug-endpoint',
      coverage: {
        tsc: Boolean(result.tscResult?.ran),
        tests: Boolean(result.testResult?.ran),
        security: result.subagents?.some((s) => s.id === 'subagent-sec') ?? true,
        bug: result.subagents?.some((s) => s.id === 'subagent-bug') ?? true,
        ai: result.subagents?.some((s) => s.id === 'subagent-fix') ?? false,
      },
    },
    diagnostics: (result.diagnostics ?? []).map((d) => ({
      ...d,
      verificationStatus: d.fixed
        ? d.verified === false
          ? 'attempted'
          : 'verified'
        : (d.verificationStatus ?? 'open'),
      provenance:
        d.provenance ??
        `real:${d.source} ${d.filePath}:${d.line}${d.column ? `:${d.column}` : ''} [${d.code}]`,
      evidence: d.evidence ?? [
        d.originalLine ? `source: ${d.originalLine}` : `source: ${d.filePath}:${d.line}`,
        d.explanation,
      ].filter(Boolean),
    })),
  };
}

function reconcileAfterFixScan(
  before: CodeDiagnostic[],
  scan: DebugRunResponse,
  attemptedIds: Set<string>
): DebugRunResponse {
  const afterKeys = new Set((scan.diagnostics ?? []).map(diagKey));
  const mergedBefore = before.map((d) => {
    if (!attemptedIds.has(d.id)) return d;
    const stillPresent = afterKeys.has(diagKey(d));
    const status: DiagnosticVerificationStatus = stillPresent ? 'unfixable' : 'verified';
    return {
      ...d,
      fixed: !stillPresent,
      verified: !stillPresent,
      attemptedFix: true,
      verificationStatus: status,
      unfixableReason: stillPresent
        ? 'Real backend re-scan still reports this diagnostic after repair attempt.'
        : undefined,
      provenance: d.provenance ?? `real:${d.source} ${d.filePath}:${d.line} [${d.code}]`,
    };
  });

  const mergedByKey = new Map<string, CodeDiagnostic>();
  for (const d of mergedBefore) mergedByKey.set(diagKey(d), d);
  for (const d of scan.diagnostics ?? []) {
    const key = diagKey(d);
    const prev = mergedByKey.get(key);
    mergedByKey.set(key, {
      ...d,
      verificationStatus: prev?.attemptedFix
        ? 'unfixable'
        : (d.verificationStatus ?? (d.fixed ? 'verified' : 'open')),
      attemptedFix: prev?.attemptedFix ?? d.attemptedFix,
      unfixableReason: prev?.attemptedFix ? prev.unfixableReason : d.unfixableReason,
      provenance: d.provenance ?? `real:${d.source} ${d.filePath}:${d.line} [${d.code}]`,
    });
  }

  return withScanEvidence({
    ...scan,
    diagnostics: Array.from(mergedByKey.values()),
  });
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [primaryTabs, setPrimaryTabs] = useState<string[]>([]);
  const [primaryActiveFile, setPrimaryActiveFile] = useState<string>('');
  const [secondaryTabs, setSecondaryTabs] = useState<string[]>([]);
  const [secondaryActiveFile, setSecondaryActiveFile] = useState<string>('');
  const [isSplitOpen, setIsSplitOpen] = useState<boolean>(false);
  const [focusedPane, setFocusedPane] = useState<'primary' | 'secondary'>('primary');

  const [debugResult, setDebugResult] = useState<DebugRunResponse | null>(null);
  const [agentCount] = useState<number>(10);
  const [cursorSpeed, setCursorSpeed] = useState<CursorSpeed>('slow');
  const [cursorAgents, setCursorAgents] = useState<CursorAgentState[]>(() => buildIdleAgents(10));
  const [agentOutputLogs, setAgentOutputLogs] = useState<string[]>([]);
  const [streamingFiles, setStreamingFiles] = useState<Record<string, boolean>>({});
  const [composerPlan, setComposerPlan] = useState<{
    prompt: string;
    summary: string;
    steps: ComposerPlanStep[];
  } | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ command: string; output: string; exitCode: number }>
  >([]);

  const [autoFollowAgent, setAutoFollowAgent] = useState<boolean>(true);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [isDebugging, setIsDebugging] = useState<boolean>(false);
  const [isSwarmFixing, setIsSwarmFixing] = useState<boolean>(false);
  const [isBuildingFeature, setIsBuildingFeature] = useState<boolean>(false);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isRunningCommand, setIsRunningCommand] = useState<boolean>(false);
  const [ideError, setIdeError] = useState<string | null>(null);

  const autoFollowRef = useRef(autoFollowAgent);
  autoFollowRef.current = autoFollowAgent;
  const agentCountRef = useRef(agentCount);
  agentCountRef.current = agentCount;
  const activeWorkFileRef = useRef<string>('');

  const setActiveWorkFile = useCallback((filePath: string, force = false) => {
    if (!filePath) return;
    if (!force && activeWorkFileRef.current && activeWorkFileRef.current !== filePath) return;
    activeWorkFileRef.current = filePath;
    setFocusedPane('primary');
    setPrimaryActiveFile(filePath);
    setPrimaryTabs((prev) => (prev.includes(filePath) ? prev : [...prev.slice(-7), filePath]));
  }, []);

  const openFileInPane = useCallback(
    (filePath: string, pane: 'primary' | 'secondary' = 'primary') => {
      if (!filePath) return;
      if (pane === 'secondary') {
        setIsSplitOpen(true);
        setSecondaryActiveFile(filePath);
        setSecondaryTabs((prev) => (prev.includes(filePath) ? prev : [...prev.slice(-6), filePath]));
      } else {
        setPrimaryActiveFile(filePath);
        setPrimaryTabs((prev) => (prev.includes(filePath) ? prev : [...prev.slice(-6), filePath]));
      }
    },
    []
  );

  const closeTabInPane = useCallback(
    (filePath: string, pane: 'primary' | 'secondary') => {
      if (pane === 'secondary') {
        setSecondaryTabs((prev) => {
          const next = prev.filter((p) => p !== filePath);
          if (secondaryActiveFile === filePath) {
            setSecondaryActiveFile(next[next.length - 1] ?? '');
          }
          if (next.length === 0) setIsSplitOpen(false);
          return next;
        });
      } else {
        setPrimaryTabs((prev) => {
          const next = prev.filter((p) => p !== filePath);
          if (primaryActiveFile === filePath) {
            setPrimaryActiveFile(next[next.length - 1] ?? '');
          }
          return next;
        });
      }
    },
    [primaryActiveFile, secondaryActiveFile]
  );

  const routeAgentFileToPane = useCallback(
    (filePath: string, force = false) => {
      if (!filePath || !autoFollowRef.current) return;
      setActiveWorkFile(filePath, force);
    },
    [setActiveWorkFile]
  );

  const logScanEvidence = useCallback((data: DebugRunResponse) => {
    const lines: string[] = [];
    if (data.terminalLines?.length) lines.push(...data.terminalLines);
    lines.push(
      `[scan] real diagnostics: tsc=${data.tscResult.errorCount} errors (${data.tscResult.ran ? 'ran' : 'skipped'}), tests=${data.testResult.failed} failed/${data.testResult.passed} passed (${data.testResult.ran ? data.testResult.command : 'skipped'}), total=${data.diagnostics.length}`
    );
    for (const sub of data.subagents ?? []) {
      lines.push(`[${sub.name}] ${sub.summary} (${sub.findingsCount} findings, ${sub.elapsedMs}ms)`);
    }
    setAgentOutputLogs((prev) => [...prev.slice(-180), ...lines].slice(-220));
  }, []);

  const runScanOnWorkspace = useCallback(
    async (ws: WorkspaceSnapshot): Promise<DebugRunResponse | null> => {
      setIsDebugging(true);
      setIdeError(null);
      setCursorAgents((prev) =>
        prev.map((a, idx) => ({
          ...a,
          status: idx === 0 ? 'scanning' : 'scanning',
          filePath: ws.files[0]?.path ?? null,
          line: 1,
          column: 1,
          task: 'Running real workspace scan',
          diagnosticId: null,
        }))
      );
      const firstFile = ws.files[0]?.path ?? '';
      if (firstFile) {
        activeWorkFileRef.current = firstFile;
        routeAgentFileToPane(firstFile, true);
      }
      setAgentOutputLogs((prev) => [
        ...prev.slice(-180),
        `$ real-debug-scan tsc --noEmit && tsx --test && security-audit && bug-audit (${ws.repoName})`,
      ]);
      try {
        const resp = await fetch(`/api/repo/${ws.workspaceId}/debug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ useAi: false }),
        });
        const data = await safeReadJson<DebugRunResponse & { error?: string }>(resp);
        if (!resp.ok || !data) {
          if (ws.sourceType === 'demo' || ws.workspaceId === 'demo-showcase') {
            const enriched = withScanEvidence(buildShowcaseDemoScanResult(ws));
            setDebugResult(enriched);
            logScanEvidence(enriched);
            const focusDiag = enriched.diagnostics.find((d) => !d.fixed) ?? enriched.diagnostics[0];
            if (focusDiag?.filePath) routeAgentFileToPane(focusDiag.filePath, true);
            setCursorAgents(buildIdleAgents(10));
            setIdeError(null);
            return enriched;
          }
          if (ws.workspaceId === 'custom-showcase') {
            const enriched = withScanEvidence({
              workspaceId: ws.workspaceId,
              subagents: [
                { id: 'subagent-local', name: 'Local Analyzer', specialty: 'Showcase', color: '#3b82f6', status: 'done', elapsedMs: 10, findingsCount: 0, summary: 'Local showcase scan (no backend).' },
              ],
              diagnostics: [],
              tscResult: { ran: false, filesChecked: ws.files.length, errorCount: 0, warningCount: 0, durationMs: 10, output: 'Showcase mode: backend unavailable. No real tsc/test run.' },
              testResult: { ran: false, command: 'node --test', exitCode: 0, durationMs: 0, passed: 0, failed: 0, skipped: 0, output: 'Showcase mode: tests not executed without backend.' },
              terminalLines: ['[showcase] Local upload loaded without backend. Real scan/fix requires Node server.'],
              gitDiff: computeShowcaseGitDiff({}, ws.fileContents),
              fileStatuses: ws.fileStatuses ?? {},
              totalElapsedMs: 10,
            });
            setDebugResult(enriched);
            logScanEvidence(enriched);
            setCursorAgents(buildIdleAgents(10));
            setIdeError(null);
            return enriched;
          }
          throw new Error(
            data?.error ||
              'Backend unavailable for real scan (this deployed URL is UI/showcase only). Run the Node server for full functionality.'
          );
        }
        const enriched = withScanEvidence(data);
        setDebugResult(enriched);
        setWorkspace((prev) =>
          prev && enriched.fileStatuses ? { ...prev, fileStatuses: enriched.fileStatuses } : prev
        );
        logScanEvidence(enriched);
        const focusDiag = enriched.diagnostics.find((d) => !d.fixed) ?? enriched.diagnostics[0];
        if (focusDiag?.filePath) routeAgentFileToPane(focusDiag.filePath, true);
        setCursorAgents(buildIdleAgents(10));
        return enriched;
      } catch (err) {
        if (ws.sourceType === 'demo' || ws.workspaceId === 'demo-showcase') {
          const enriched = withScanEvidence(buildShowcaseDemoScanResult(ws));
          setDebugResult(enriched);
          logScanEvidence(enriched);
          const focusDiag = enriched.diagnostics.find((d) => !d.fixed) ?? enriched.diagnostics[0];
          if (focusDiag?.filePath) routeAgentFileToPane(focusDiag.filePath, true);
          setCursorAgents(buildIdleAgents(10));
          setIdeError(null);
          return enriched;
        }
        if (ws.workspaceId === 'custom-showcase') {
          const enriched = withScanEvidence({
            workspaceId: ws.workspaceId,
            subagents: [{ id: 'subagent-local', name: 'Local Analyzer', specialty: 'Showcase', color: '#3b82f6', status: 'done', elapsedMs: 10, findingsCount: 0, summary: 'Local showcase scan (no backend).' }],
            diagnostics: [],
            tscResult: { ran: false, filesChecked: ws.files.length, errorCount: 0, warningCount: 0, durationMs: 10, output: 'Showcase mode: backend unavailable. No real tsc/test run.' },
            testResult: { ran: false, command: 'node --test', exitCode: 0, durationMs: 0, passed: 0, failed: 0, skipped: 0, output: 'Showcase mode: tests not executed without backend.' },
            terminalLines: ['[showcase] Local upload loaded without backend. Real scan/fix requires Node server.'],
            gitDiff: computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, ws.fileContents),
            fileStatuses: ws.fileStatuses ?? {},
            totalElapsedMs: 10,
          });
          setDebugResult(enriched);
          logScanEvidence(enriched);
          setCursorAgents(buildIdleAgents(10));
          setIdeError(null);
          return enriched;
        }
        setIdeError(err instanceof Error ? err.message : 'Scan failed.');
        setCursorAgents(buildIdleAgents(10));
        return null;
      } finally {
        setIsDebugging(false);
      }
    },
    [logScanEvidence, routeAgentFileToPane]
  );

  const consumeSwarmSse = useCallback(
    async (ws: WorkspaceSnapshot, resp: Response) => {
      if (!resp.ok || !resp.body) {
        const data = await safeReadJson<{ error?: string }>(resp);
        throw new Error(
          data?.error ||
            'Backend unavailable for swarm streaming (this deployed URL is UI/showcase only). Run the Node server for real scan/fix.'
        );
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const rawJson = line.slice(6).trim();
          if (!rawJson) continue;

          const evt = JSON.parse(rawJson) as SwarmStreamEvent;

          if (evt.type === 'phase') {
            setAgentOutputLogs((prev) => [...prev.slice(-180), `[${evt.phase}] ${evt.message}`]);
          } else if (evt.type === 'composer:plan') {
            setComposerPlan({
              prompt: evt.prompt,
              summary: evt.summary,
              steps: evt.steps,
            });
            if (evt.steps[0]?.filePath) routeAgentFileToPane(evt.steps[0].filePath, true);
          } else if (evt.type === 'diagnostics:ready') {
            setDebugResult((prev) =>
              withScanEvidence({
                workspaceId: ws.workspaceId,
                subagents: prev?.subagents ?? [],
                diagnostics: evt.diagnostics,
                tscResult: evt.tscResult,
                testResult: evt.testResult,
                terminalLines: prev?.terminalLines ?? [],
                gitDiff: prev?.gitDiff ?? '',
                fileStatuses: prev?.fileStatuses,
                totalElapsedMs: prev?.totalElapsedMs ?? 0,
              })
            );
            const first = evt.diagnostics[0]?.filePath;
            if (first) routeAgentFileToPane(first, true);
          } else if (evt.type === 'agent:update') {
            setCursorAgents((prev) => {
              const exists = prev.some((a) => a.id === evt.agent.id);
              const nextAgent = {
                ...evt.agent,
                filePath:
                  evt.agent.filePath && activeWorkFileRef.current
                    ? activeWorkFileRef.current
                    : evt.agent.filePath,
              };
              if (!exists) return [...prev, nextAgent];
              return prev.map((a) => (a.id === evt.agent.id ? nextAgent : a));
            });
            if (evt.logLine) {
              setAgentOutputLogs((prev) => [...prev.slice(-180), evt.logLine!]);
            }
            const workFile =
              activeWorkFileRef.current ||
              (['navigating', 'writing', 'editing', 'scanning', 'verifying'].includes(evt.agent.status)
                ? evt.agent.filePath
                : null);
            if (workFile) routeAgentFileToPane(workFile, !activeWorkFileRef.current);
          } else if (evt.type === 'file:streaming') {
            const filePath = activeWorkFileRef.current || evt.filePath;
            activeWorkFileRef.current = filePath;
            setStreamingFiles((prev) => ({ ...prev, [filePath]: true }));
            setWorkspace((prev) => {
              if (!prev) return prev;
              const nextFiles = evt.files ?? prev.files;
              return {
                ...prev,
                files: nextFiles,
                fileContents: { ...prev.fileContents, [filePath]: evt.content },
              };
            });
            routeAgentFileToPane(filePath, true);
          } else if (evt.type === 'file:created') {
            const filePath = activeWorkFileRef.current || evt.filePath;
            activeWorkFileRef.current = filePath;
            setStreamingFiles((prev) => ({ ...prev, [filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    files: evt.files,
                    fileStatuses: evt.fileStatuses,
                    fileContents: { ...prev.fileContents, [filePath]: evt.content },
                  }
                : prev
            );
            setComposerPlan((prev) =>
              prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.filePath === filePath ? { ...s, status: 'done' } : s
                    ),
                  }
                : prev
            );
            setDebugResult((prev) =>
              prev ? { ...prev, gitDiff: evt.gitDiff, fileStatuses: evt.fileStatuses } : prev
            );
            routeAgentFileToPane(filePath, true);
            setAgentOutputLogs((prev) => [
              ...prev.slice(-180),
              `[${evt.agentName}] Created ${filePath} (real workspace write)`,
            ]);
          } else if (evt.type === 'file:patched') {
            const filePath = activeWorkFileRef.current || evt.filePath;
            activeWorkFileRef.current = filePath;
            setStreamingFiles((prev) => ({ ...prev, [filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    fileStatuses: evt.fileStatuses ?? prev.fileStatuses,
                    fileContents: { ...prev.fileContents, [filePath]: evt.content },
                  }
                : prev
            );
            setComposerPlan((prev) =>
              prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.filePath === filePath ? { ...s, status: 'done' } : s
                    ),
                  }
                : prev
            );
            setDebugResult((prev) =>
              prev
                ? {
                    ...prev,
                    gitDiff: evt.gitDiff,
                    fileStatuses: evt.fileStatuses ?? prev.fileStatuses,
                    diagnostics: prev.diagnostics.map((d) =>
                      evt.diagnosticIds.includes(d.id)
                        ? {
                            ...d,
                            attemptedFix: true,
                            verificationStatus: 'attempted',
                            provenance: d.provenance ?? `real:${d.source} ${d.filePath}:${d.line} [${d.code}]`,
                          }
                        : d
                    ),
                  }
                : prev
            );
            routeAgentFileToPane(filePath, true);
            setAgentOutputLogs((prev) => [
              ...prev.slice(-180),
              `[${evt.agentName}] Patched ${filePath}:${evt.line} (awaiting verified server result)`,
            ]);
          } else if (evt.type === 'file:reverted') {
            const filePath = activeWorkFileRef.current || evt.filePath;
            setStreamingFiles((prev) => ({ ...prev, [filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    fileContents: { ...prev.fileContents, [filePath]: evt.content },
                  }
                : prev
            );
            setDebugResult((prev) =>
              prev
                ? {
                    ...prev,
                    gitDiff: evt.gitDiff,
                    diagnostics: prev.diagnostics.map((d) =>
                      d.filePath === filePath && d.verificationStatus === 'attempted'
                        ? {
                            ...d,
                            fixed: false,
                            verified: false,
                            verificationStatus: 'reverted',
                            unfixableReason: evt.reason,
                          }
                        : d
                    ),
                  }
                : prev
            );
            routeAgentFileToPane(filePath, true);
            setAgentOutputLogs((prev) => [...prev.slice(-180), `[ROLLBACK] ${evt.reason}`]);
          } else if (evt.type === 'swarm:complete') {
            setStreamingFiles({});
            const verified = withScanEvidence({
              ...evt.result,
              diagnostics: (evt.result.diagnostics ?? []).map((d) => ({
                ...d,
                verificationStatus: d.fixed ? 'verified' : (d.verificationStatus ?? 'open'),
                verified: d.fixed ? true : d.verified,
              })),
            });
            setDebugResult(verified);
            setCursorAgents(
              (evt.agents ?? []).map((a, idx) => ({
                ...a,
                name: a.name?.startsWith('Cursor') ? a.name : `Cursor ${idx + 1}`,
                filePath: activeWorkFileRef.current || a.filePath,
              }))
            );
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    files: evt.files ?? prev.files,
                    fileStatuses: evt.fileStatuses ?? evt.result.fileStatuses ?? prev.fileStatuses,
                    fileContents: evt.fileContents,
                  }
                : prev
            );
            if (verified.diagnostics[0]?.filePath) routeAgentFileToPane(verified.diagnostics[0].filePath, true);
            logScanEvidence(verified);
            setAgentOutputLogs((prev) => [
              ...prev.slice(-180),
              `[swarm:complete] verified server results: fixed=${evt.fixedCount}, created=${evt.createdCount ?? 0}, remaining=${verified.diagnostics.filter((d) => !d.fixed).length}`,
            ]);
            activeWorkFileRef.current = '';
          } else if (evt.type === 'error') {
            setIdeError(evt.message);
            setAgentOutputLogs((prev) => [...prev.slice(-180), `[error] ${evt.message}`]);
          }
        }
      }
    },
    [logScanEvidence, routeAgentFileToPane]
  );

  const runSwarmFixOnWorkspace = useCallback(
    async (ws: WorkspaceSnapshot, _count: number, speed: CursorSpeed) => {
      const fixedCount = 10;
      setIsSwarmFixing(true);
      setIdeError(null);
      setIsSplitOpen(false);
      activeWorkFileRef.current = (debugResult?.diagnostics ?? []).find((d) => !d.fixed)?.filePath ?? ws.files[0]?.path ?? '';
      setCursorAgents(buildIdleAgents(fixedCount));
      setAgentOutputLogs([`$ swarm fix --cursors=${fixedCount} --speed=${speed} (${ws.repoName})`]);

      const runShowcaseFix = async () => {
        const mult = speed === 'fast' ? 0.25 : speed === 'normal' ? 0.55 : 1;
        const dly = (ms: number) => sleep(Math.round(ms * mult));
        let curWs: WorkspaceSnapshot = { ...ws, fileContents: { ...ws.fileContents }, fileStatuses: { ...(ws.fileStatuses ?? {}) } };
        let scan = withScanEvidence(buildShowcaseDemoScanResult(curWs));
        const fixable = scan.diagnostics.filter((d) => !d.fixed && (d.suggestedLinePatch || d.suggestedFilePatch));
        const byFile = new Map<string, typeof fixable>();
        for (const d of fixable) {
          const arr = byFile.get(d.filePath) ?? [];
          arr.push(d);
          byFile.set(d.filePath, arr);
        }

        setDebugResult(scan);
        setAgentOutputLogs((p) => [...p, `[diagnosing] Scanning workspace (showcase)...`, `[diagnostics:ready] ${scan.diagnostics.length} diagnostic(s) found`]);

        if (fixable.length === 0) {
          setAgentOutputLogs((p) => [...p, `[complete] Workspace clean (showcase).`]);
          setCursorAgents(buildIdleAgents(10).map((a) => ({ ...a, status: 'done' as const, task: 'No issues to fix' })));
          return;
        }

        setAgentOutputLogs((p) => [...p, `[fixing] 10 cursors converged on ${byFile.size} file(s) (showcase)...`]);
        let fixedTotal = 0;

        for (const [filePath, diags] of byFile.entries()) {
          activeWorkFileRef.current = filePath;
          routeAgentFileToPane(filePath, true);
          const sorted = [...diags].sort((a, b) => b.line - a.line);
          setCursorAgents((prev) => prev.map((a, i) => ({ ...a, status: 'scanning' as const, filePath, line: Math.max(1, (sorted[0]?.line ?? 1) - i), column: 1, task: `Scanning ${filePath}`, diagnosticId: null })));
          await dly(180);

          let content = curWs.fileContents[filePath] ?? '';
          for (let idx = 0; idx < sorted.length; idx++) {
            const diag = sorted[idx];
            const writer = SWARM_CURSOR_PROFILES[idx % 10];
            setCursorAgents((prev) => prev.map((a, i) => ({ ...a, status: i === (idx % 10) ? 'writing' : 'scanning' as const, filePath, line: diag.line, column: 4 + i, task: i === (idx % 10) ? `Fixing ${diag.code} at ${filePath}:${diag.line}` : `Assisting in ${filePath}`, diagnosticId: diag.id })));
            setAgentOutputLogs((p) => [...p.slice(-180), `[${writer.name}] → ${filePath}:${diag.line} [${diag.code}] ${diag.title}`]);
            await dly(220);

            const before = content;
            const after = applyDiagnosticFixToContent(content, diag);
            if (after !== before) {
              // streaming effect
              setStreamingFiles((p) => ({ ...p, [filePath]: true }));
              const lines = after.split('\n');
              const steps = Math.min(6, Math.max(3, lines.length));
              for (let s = 1; s <= steps; s++) {
                const partial = lines.slice(0, Math.max(1, Math.floor((lines.length * s) / steps))).join('\n') + (s < steps ? '\n' : '');
                setWorkspace((prev) => prev ? { ...prev, fileContents: { ...prev.fileContents, [filePath]: s === steps ? after : partial } } : prev);
                setCursorAgents((prev) => prev.map((a, i) => ({ ...a, status: i === (idx % 10) ? 'writing' : 'scanning' as const, line: Math.min(diag.line, 1 + Math.floor((s / steps) * Math.max(1, diag.line))), column: 6 + s * 3 + i })));
                await dly(90);
              }
              content = after;
              curWs = { ...curWs, fileContents: { ...curWs.fileContents, [filePath]: content }, fileStatuses: { ...(curWs.fileStatuses ?? {}), [filePath]: 'M' } };
              setStreamingFiles((p) => ({ ...p, [filePath]: false }));
              setWorkspace(curWs);
              setDebugResult((prev) => prev ? { ...prev, gitDiff: computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, curWs.fileContents), fileStatuses: curWs.fileStatuses } : prev);
              setAgentOutputLogs((p) => [...p.slice(-180), `[${writer.name}] Patched ${filePath}:${diag.line} (showcase)`]);
              fixedTotal++;
              await dly(120);
            }
          }

          setCursorAgents((prev) => prev.map((a) => ({ ...a, status: 'verifying' as const, filePath, task: `Verifying ${filePath}`, diagnosticId: null })));
          await dly(220);
          scan = withScanEvidence(buildShowcaseDemoScanResult(curWs));
          scan.gitDiff = computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, curWs.fileContents);
          scan.fileStatuses = curWs.fileStatuses;
          setDebugResult(scan);
          setWorkspace(curWs);
        }

        setAgentOutputLogs((p) => [...p.slice(-180), `[verifying] Final showcase re-scan...`]);
        await dly(200);
        const finalScan = withScanEvidence(buildShowcaseDemoScanResult(curWs));
        finalScan.gitDiff = computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, curWs.fileContents);
        finalScan.fileStatuses = curWs.fileStatuses;
        setDebugResult(finalScan);
        setCursorAgents((prev) => prev.map((a) => ({ ...a, status: 'done' as const, filePath: null, diagnosticId: null, task: `Applied ${fixedTotal} verified patch(es)` })));
        setAgentOutputLogs((p) => [...p.slice(-180), `[complete] Verified ${fixedTotal} patch(es), ${finalScan.diagnostics.length} diagnostic(s) remain (showcase).`]);
        const focus = finalScan.diagnostics[0]?.filePath ?? ws.files[0]?.path;
        if (focus) routeAgentFileToPane(focus, true);
        logScanEvidence(finalScan);
      };

      try {
        if (isShowcaseWs(ws)) {
          await runShowcaseFix();
        } else {
          const resp = await fetch(`/api/repo/${ws.workspaceId}/swarm-fix`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentCount: fixedCount, speed, useAi: true }),
          });
          if (!resp.ok || !resp.body) {
            if (isShowcaseWs(ws)) await runShowcaseFix();
            else throw new Error((await safeReadJson<{error?:string}>(resp))?.error || 'Swarm stream failed.');
          } else {
            await consumeSwarmSse(ws, resp);
            await runScanOnWorkspace(ws);
          }
        }
      } catch (err) {
        if (isShowcaseWs(ws)) {
          try { await runShowcaseFix(); } catch (e) { setIdeError(e instanceof Error ? e.message : 'Swarm execution failed.'); }
        } else {
          setIdeError(err instanceof Error ? err.message : 'Swarm execution failed.');
        }
      } finally {
        setIsSwarmFixing(false);
        setStreamingFiles({});
        activeWorkFileRef.current = '';
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [consumeSwarmSse, debugResult, logScanEvidence, routeAgentFileToPane, runScanOnWorkspace]
  );

  const runFeatureBuildOnWorkspace = useCallback(
    async (ws: WorkspaceSnapshot, prompt: string, _count: number, speed: CursorSpeed) => {
      const fixedCount = 10;
      setIsBuildingFeature(true);
      setIdeError(null);
      setComposerPlan(null);
      setIsSplitOpen(false);
      activeWorkFileRef.current = '';
      setCursorAgents(buildIdleAgents(fixedCount));
      setAgentOutputLogs((prev) => [
        ...prev.slice(-180),
        `$ swarm build "${prompt}" --cursors=${fixedCount} --speed=${speed}`,
      ]);

      const runShowcaseBuild = async () => {
        const mult = speed === 'fast' ? 0.25 : speed === 'normal' ? 0.55 : 1;
        const dly = (ms: number) => sleep(Math.round(ms * mult));
        const slug = (prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)) || 'feature';
        const filePath = `src/${slug}.ts`;
        const content = [
          `// Generated in showcase mode for: ${prompt}`,
          '',
          'export function runFeature() {',
          `  return ${JSON.stringify(prompt)};`,
          '}',
          '',
        ].join('\n');
        const steps = [{ id: 'step-1', filePath, action: 'create' as const, description: `Create ${filePath} (showcase)`, agentId: SWARM_CURSOR_PROFILES[0].id, status: 'pending' as const }];
        setComposerPlan({ prompt, summary: `Planned 1 file for "${prompt}" (showcase)`, steps });
        setAgentOutputLogs((p) => [...p, '[planning] Building one-file plan (showcase)...', `[composer:plan] ${filePath}`]);
        await dly(250);

        activeWorkFileRef.current = filePath;
        routeAgentFileToPane(filePath, true);
        setComposerPlan({ prompt, summary: `Building ${filePath} (showcase)`, steps: [{ ...steps[0], status: 'in_progress' }] });
        setAgentOutputLogs((p) => [...p, `[writing] Creating ${filePath}...`]);

        const lines = content.split('\n');
        let partial = '';
        for (let i = 0; i < lines.length; i++) {
          partial += (i === 0 ? '' : '\n') + lines[i];
          setStreamingFiles((p) => ({ ...p, [filePath]: true }));
          setCursorAgents((prev) => prev.map((a, idx) => ({ ...a, status: idx === 0 ? 'writing' : 'scanning', filePath, line: i + 1, column: Math.max(1, lines[i].length), task: idx === 0 ? `Writing ${filePath}:${i + 1}` : `Assisting ${filePath}` })));
          setWorkspace((prev) => {
            if (!prev) return prev;
            const exists = prev.files.some((f) => f.path === filePath);
            const node = { path: filePath, name: filePath.split('/').pop() || filePath, language: 'typescript', size: partial.length, lineCount: partial.split('\n').length, diagnosticCount: 0 };
            return { ...prev, files: exists ? prev.files.map(f=>f.path===filePath?node:f) : [...prev.files, node], fileContents: { ...prev.fileContents, [filePath]: partial } };
          });
          await dly(60);
        }

        setStreamingFiles((p) => ({ ...p, [filePath]: false }));
        setWorkspace((prev) => {
          if (!prev) return prev;
          const nextContents = { ...prev.fileContents, [filePath]: content };
          const nextStatuses = { ...(prev.fileStatuses ?? {}), [filePath]: 'A' as GitFileStatus };
          return { ...prev, fileContents: nextContents, fileStatuses: nextStatuses };
        });
        setComposerPlan({ prompt, summary: `Created ${filePath} (showcase)`, steps: [{ ...steps[0], status: 'done' }] });
        setAgentOutputLogs((p) => [...p, `[verifying] Checking generated file (showcase)...`, `[complete] Created ${filePath} (showcase).`]);
        await dly(150);
        const finalWs = ((): WorkspaceSnapshot | null => {
          // best-effort: build from current workspace state is async in React; rescan will read latest via closure in many cases, but easier to refresh after
          return null;
        })();
        void finalWs;
        await runScanOnWorkspace({ ...ws, fileContents: { ...ws.fileContents, [filePath]: content }, fileStatuses: { ...(ws.fileStatuses ?? {}), [filePath]: 'A' }, files: [...ws.files.filter(f=>f.path!==filePath), { path: filePath, name: filePath.split('/').pop()||filePath, language:'typescript', size: content.length, lineCount: content.split('\n').length, diagnosticCount: 0 }] });
      };

      try {
        if (isShowcaseWs(ws)) {
          await runShowcaseBuild();
        } else {
          const resp = await fetch(`/api/repo/${ws.workspaceId}/composer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, agentCount: fixedCount, speed, useAi: true }),
          });
          if (!resp.ok || !resp.body) {
            if (isShowcaseWs(ws)) await runShowcaseBuild();
            else throw new Error((await safeReadJson<{error?:string}>(resp))?.error || 'Feature build failed.');
          } else {
            await consumeSwarmSse(ws, resp);
            await runScanOnWorkspace(ws);
          }
        }
      } catch (err) {
        if (isShowcaseWs(ws)) {
          try { await runShowcaseBuild(); } catch (e) { setIdeError(e instanceof Error ? e.message : 'Feature build failed.'); }
        } else {
          setIdeError(err instanceof Error ? err.message : 'Feature build failed.');
        }
      } finally {
        setIsBuildingFeature(false);
        setStreamingFiles({});
        activeWorkFileRef.current = '';
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [consumeSwarmSse, routeAgentFileToPane, runScanOnWorkspace]
  );

  const handleImportWorkspaceSnapshot = useCallback(
    async (
      payload: {
        source: 'github' | 'workspace' | 'custom' | 'demo';
        repoUrl?: string;
        name?: string;
        files?: Array<{ path: string; content: string }>;
      },
      autoScan = true
    ) => {
      setIsImporting(true);
      setIdeError(null);
      setComposerPlan(null);
      setTerminalHistory([]);
      activeWorkFileRef.current = '';
      try {
        let data: WorkspaceSnapshot | null = null;

        if (payload.source === 'demo') {
          try {
            const resp = await fetch('/api/repo/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const parsed = await safeReadJson<WorkspaceSnapshot & { error?: string }>(resp);
            if (resp.ok && parsed && !(parsed as { error?: string }).error) data = parsed as WorkspaceSnapshot;
          } catch {
            // fallback to local showcase demo
          }
          if (!data) data = buildClientDemoSnapshot();
        } else {
          let parsed: (WorkspaceSnapshot & { error?: string }) | null = null;
          try {
            const resp = await fetch('/api/repo/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            parsed = await safeReadJson<WorkspaceSnapshot & { error?: string }>(resp);
            if (resp.ok && parsed && !(parsed as { error?: string }).error) data = parsed as WorkspaceSnapshot;
          } catch {
            parsed = null;
          }
          if (!data) {
            if (payload.source === 'custom' && payload.files?.length) {
              const fileContents: Record<string, string> = {};
              const files: RepoFileNode[] = payload.files.map((f) => {
                fileContents[f.path] = f.content;
                return {
                  path: f.path,
                  name: f.path.split('/').pop() ?? f.path,
                  language: inferLanguage(f.path),
                  size: f.content.length,
                  lineCount: f.content.split('\n').length,
                  diagnosticCount: 0,
                };
              });
              data = {
                workspaceId: 'custom-showcase',
                repoName: payload.name || 'custom/uploaded-files',
                repoUrl: 'local://uploaded',
                sourceType: 'custom',
                branch: 'main',
                files,
                fileContents,
                fileStatuses: {},
              };
            } else {
              throw new Error(
                parsed?.error ||
                  'Backend unavailable for repository import (this deployed URL is UI/showcase only). Use Demo/Upload, or run the Node server to clone/import real repos.'
              );
            }
          }
        }

        const { primary, secondary } = pickInitialFiles(data);
        setWorkspace(data);
        setDebugResult(null);
        setCursorAgents(buildIdleAgents(10));
        setAgentOutputLogs([
          data.workspaceId === 'demo-showcase'
            ? `Loaded local showcase demo (${data.files.length} files). Backend API unavailable on this deploy; showing sample diagnostics/UI flow.`
            : `Imported ${data.repoName} (${data.files.length} files) from ${data.sourceType}. Ready to scan real diagnostics.`,
        ]);
        setPrimaryTabs(primary ? [primary] : []);
        setPrimaryActiveFile(primary);
        setSecondaryTabs(secondary && secondary !== primary ? [secondary] : primary ? [primary] : []);
        setSecondaryActiveFile(secondary || primary);
        setIsSplitOpen(false);
        if (autoScan) {
          await runScanOnWorkspace(data);
        }
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Repository import failed.');
      } finally {
        setIsImporting(false);
      }
    },
    [runScanOnWorkspace]
  );

  // No demo auto-import on mount; UI starts ready to clone/import real GitHub repo and scan it.

  const handleCreateFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      setIsApplying(true);
      setIdeError(null);
      try {
        if (isShowcaseWs(workspace)) {
          const content = `// ${filePath}\n`;
          const fileNode: RepoFileNode = {
            path: filePath,
            name: filePath.split('/').pop() ?? filePath,
            language: inferLanguage(filePath),
            size: content.length,
            lineCount: content.split('\n').length,
            diagnosticCount: 0,
          };
          const nextFiles = [...workspace.files.filter((f) => f.path !== filePath), fileNode].sort((a,b)=>a.path.localeCompare(b.path));
          const nextContents = { ...workspace.fileContents, [filePath]: content };
          const nextStatuses = { ...(workspace.fileStatuses ?? {}), [filePath]: 'A' as GitFileStatus };
          const nextWs = { ...workspace, files: nextFiles, fileContents: nextContents, fileStatuses: nextStatuses };
          setWorkspace(nextWs);
          setDebugResult((prev) => prev ? { ...prev, gitDiff: computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, nextContents), fileStatuses: nextStatuses } : prev);
          openFileInPane(filePath, focusedPane);
          return;
        }
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/create-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, content: `// ${filePath}\n` }),
        });
        const data = await safeReadJson<{
          filePath: string;
          files: RepoFileNode[];
          fileContents: Record<string, string>;
          gitDiff: string;
          fileStatuses: Record<string, GitFileStatus>;
          error?: string;
        }>(resp);
        if (!resp.ok || !data) throw new Error(data?.error || 'Backend unavailable (showcase/static deploy cannot create files).');
        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                files: data.files,
                fileContents: data.fileContents,
                fileStatuses: data.fileStatuses,
              }
            : prev
        );
        setDebugResult((prev) =>
          prev ? { ...prev, gitDiff: data.gitDiff, fileStatuses: data.fileStatuses } : prev
        );
        openFileInPane(data.filePath, focusedPane);
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'File creation failed.');
      } finally {
        setIsApplying(false);
      }
    },
    [focusedPane, openFileInPane, workspace]
  );

  const handleRunTerminalCommand = useCallback(
    async (command: string) => {
      if (!workspace) return;
      setIsRunningCommand(true);
      try {
        if (isShowcaseWs(workspace)) {
          const cmd = command.trim();
          let output = '';
          let exitCode = 0;
          const files = workspace.files.map((f) => f.path).sort().join('\n');
          if (cmd === 'ls' || cmd === 'dir') output = files || '(empty)';
          else if (cmd === 'help') output = 'Available (showcase): help, ls, git status, git diff, tsc --noEmit, tsx --test, node --test, cat <file>';
          else if (cmd === 'git status') {
            const changed = Object.keys(workspace.fileStatuses ?? {});
            output = changed.length ? `On branch main\nChanges:\n${changed.map(p=>` M ${p}`).join('\n')}` : 'On branch main\nnothing to commit, working tree clean';
          } else if (cmd === 'git diff') {
            output = debugResult?.gitDiff || computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, workspace.fileContents) || '(no changes)';
          } else if (cmd === 'tsc --noEmit') {
            const errs = (debugResult?.diagnostics ?? []).filter(d=>!d.fixed && d.severity==='error');
            output = errs.length ? errs.map(d=>`${d.filePath}:${d.line}:${d.column} - error ${d.code}: ${d.message}`).join('\n') : 'No TypeScript errors (showcase).';
            exitCode = errs.length ? 1 : 0;
          } else if (cmd === 'tsx --test' || cmd === 'node --test') {
            output = debugResult?.testResult?.output || 'No tests executed in showcase mode.';
          } else if (cmd.startsWith('cat ')) {
            const p = cmd.slice(4).trim();
            output = workspace.fileContents[p] ?? `cat: ${p}: No such file`;
            if (!workspace.fileContents[p]) exitCode = 1;
          } else {
            output = 'Command not available in Vercel showcase mode. Run the Node backend for real terminal commands.';
            exitCode = 1;
          }
          setTerminalHistory((prev) => [...prev.slice(-30), { command, output, exitCode }]);
          setAgentOutputLogs((prev) => [...prev.slice(-180), `$ ${command}`, ...(output ? output.split('\n').slice(0, 12) : ['(no output)'])]);
          return;
        }
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/run-command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        const data = await safeReadJson<{ exitCode: number; output: string; error?: string }>(resp);
        if (!resp.ok || !data) throw new Error(data?.error || 'Backend unavailable (showcase/static deploy cannot run commands).');
        setTerminalHistory((prev) => [
          ...prev.slice(-30),
          { command, output: data.output, exitCode: data.exitCode },
        ]);
        setAgentOutputLogs((prev) => [
          ...prev.slice(-180),
          `$ ${command}`,
          ...(data.output ? data.output.split('\n').slice(0, 12) : ['(no output)']),
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Terminal error';
        setTerminalHistory((prev) => [...prev, { command, output: message, exitCode: 1 }]);
      } finally {
        setIsRunningCommand(false);
      }
    },
    [debugResult, workspace]
  );

  const applyWorkspacePatch = useCallback(
    async (opts: {
      diagnosticId?: string;
      applyAll?: boolean;
      manualEdit?: { filePath: string; content: string };
    }) => {
      if (!workspace) return;
      const beforeDiagnostics = debugResult?.diagnostics ?? [];
      const targetIds = opts.applyAll
        ? new Set(beforeDiagnostics.filter((d) => !d.fixed && (d.suggestedLinePatch || d.suggestedFilePatch)).map((d) => d.id))
        : opts.diagnosticId
          ? new Set([opts.diagnosticId])
          : new Set<string>();

      if (opts.manualEdit?.filePath) routeAgentFileToPane(opts.manualEdit.filePath, true);
      if (opts.diagnosticId) {
        const target = beforeDiagnostics.find((d) => d.id === opts.diagnosticId);
        if (target?.filePath) routeAgentFileToPane(target.filePath, true);
      }

      setIsApplying(true);
      setIdeError(null);
      setCursorAgents((prev) =>
        prev.map((a, idx) => ({
          ...a,
          status: idx === 0 ? 'editing' : 'verifying',
          filePath:
            opts.manualEdit?.filePath ??
            beforeDiagnostics.find((d) => targetIds.has(d.id))?.filePath ??
            a.filePath,
          task: opts.manualEdit ? 'Applying manual edit (local workspace write)' : 'Applying repair (local showcase mode)',
          diagnosticId: opts.diagnosticId ?? null,
        }))
      );
      setAgentOutputLogs((prev) => [
        ...prev.slice(-180),
        opts.manualEdit
          ? `[apply-fix] writing ${opts.manualEdit.filePath}`
          : `[apply-fix] repair attempt (${opts.applyAll ? 'all fixable diagnostics' : opts.diagnosticId ?? 'single'})`,
      ]);

      const applyShowcaseLocal = () => {
        const prevContents = { ...workspace.fileContents };
        let nextContents = { ...workspace.fileContents };
        let appliedCount = 0;

        if (opts.manualEdit) {
          if (nextContents[opts.manualEdit.filePath] !== opts.manualEdit.content) {
            nextContents = { ...nextContents, [opts.manualEdit.filePath]: opts.manualEdit.content };
            appliedCount = 1;
          }
        } else if (opts.applyAll) {
          const { updatedFiles, appliedIds } = applyAllFixesToFiles(nextContents, beforeDiagnostics.filter((d) => !d.fixed));
          nextContents = { ...nextContents, ...updatedFiles };
          appliedCount = appliedIds.size;
        } else if (opts.diagnosticId) {
          const d = beforeDiagnostics.find((x) => x.id === opts.diagnosticId);
          if (d && (d.suggestedLinePatch || d.suggestedFilePatch)) {
            const before = nextContents[d.filePath] ?? '';
            const after = applyDiagnosticFixToContent(before, d);
            if (after !== before) {
              nextContents = { ...nextContents, [d.filePath]: after };
              appliedCount = 1;
            }
          }
        }

        const changedPaths = Object.keys(nextContents).filter((p) => nextContents[p] !== prevContents[p]);
        const nextStatuses: Record<string, GitFileStatus> = { ...(workspace.fileStatuses ?? {}) };
        for (const p of changedPaths) nextStatuses[p] = nextStatuses[p] ?? 'M';

        const nextWs: WorkspaceSnapshot = {
          ...workspace,
          fileContents: nextContents,
          fileStatuses: nextStatuses,
        };
        setWorkspace(nextWs);
        const scan = withScanEvidence(buildShowcaseDemoScanResult(nextWs));
        const reconciled = reconcileAfterFixScan(beforeDiagnostics, scan, targetIds);
        reconciled.gitDiff = computeShowcaseGitDiff(buildClientDemoSnapshot().fileContents, nextContents);
        setDebugResult(reconciled);
        const remaining = reconciled.diagnostics.filter((d) => !d.fixed).length;
        const verified = reconciled.diagnostics.filter((d) => d.verificationStatus === 'verified').length;
        const unfixable = reconciled.diagnostics.filter((d) => d.verificationStatus === 'unfixable').length;
        setAgentOutputLogs((prev) => [
          ...prev.slice(-180),
          `[apply-fix] local result: applied=${appliedCount}, verified=${verified}, unfixable=${unfixable}, remaining=${remaining}`,
        ]);
      };

      try {
        if (isShowcaseWs(workspace)) {
          applyShowcaseLocal();
          return;
        }
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/apply-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            diagnostics: beforeDiagnostics,
            ...opts,
          }),
        });
        const data = await safeReadJson<ApplyFixResponse & { error?: string }>(resp);
        if (!resp.ok || !data) {
          if (isShowcaseWs(workspace)) { applyShowcaseLocal(); return; }
          throw new Error(data?.error || 'Backend unavailable (showcase/static deploy cannot apply real fixes).');
        }

        setWorkspace((prev) =>
          prev
            ? {
                ...prev,
                fileContents: { ...prev.fileContents, ...data.updatedFiles },
                fileStatuses: data.fileStatuses ?? prev.fileStatuses,
              }
            : prev
        );

        const verifiedScan = await runScanOnWorkspace({
          ...workspace,
          fileContents: { ...workspace.fileContents, ...data.updatedFiles },
          fileStatuses: data.fileStatuses ?? workspace.fileStatuses,
        });
        if (verifiedScan) {
          const reconciled = reconcileAfterFixScan(beforeDiagnostics, verifiedScan, targetIds);
          setDebugResult(reconciled);
          const remaining = reconciled.diagnostics.filter((d) => !d.fixed).length;
          const verified = reconciled.diagnostics.filter((d) => d.verificationStatus === 'verified').length;
          const unfixable = reconciled.diagnostics.filter((d) => d.verificationStatus === 'unfixable').length;
          setAgentOutputLogs((prev) => [
            ...prev.slice(-180),
            `[apply-fix] server-verified result: applied=${data.appliedCount}, verified=${verified}, unfixable=${unfixable}, remaining=${remaining}`,
          ]);
        } else {
          setDebugResult((prev) => (prev ? { ...prev, gitDiff: data.gitDiff } : prev));
        }
      } catch (err) {
        if (isShowcaseWs(workspace)) {
          try { applyShowcaseLocal(); } catch (e) { setIdeError(e instanceof Error ? e.message : 'Patch failed.'); }
        } else {
          setIdeError(err instanceof Error ? err.message : 'Patch write failed.');
        }
      } finally {
        setIsApplying(false);
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [debugResult, routeAgentFileToPane, runScanOnWorkspace, workspace]
  );

  const handleResetGit = useCallback(async () => {
    if (!workspace) return;
    setIsApplying(true);
    try {
      if (isShowcaseWs(workspace)) {
        const nextWs = buildClientDemoSnapshot();
        const { primary, secondary } = pickInitialFiles(nextWs);
        activeWorkFileRef.current = '';
        setWorkspace(nextWs);
        setComposerPlan(null);
        setPrimaryTabs(primary ? [primary] : []);
        setPrimaryActiveFile(primary);
        setSecondaryTabs(secondary ? [secondary] : []);
        setSecondaryActiveFile(secondary);
        setCursorAgents(buildIdleAgents(10));
        setAgentOutputLogs(['Git working tree reset to clean showcase baseline.']);
        await runScanOnWorkspace(nextWs);
        return;
      }
      const resp = await fetch(`/api/repo/${workspace.workspaceId}/reset`, { method: 'POST' });
      const data = await safeReadJson<{
        files: WorkspaceSnapshot['files'];
        fileContents: Record<string, string>;
        gitDiff: string;
        fileStatuses: Record<string, GitFileStatus>;
        error?: string;
      }>(resp);
      if (!resp.ok || !data) throw new Error(data?.error || 'Backend unavailable (showcase/static deploy cannot reset).');
      const nextWs: WorkspaceSnapshot = {
        ...workspace,
        files: data.files,
        fileContents: data.fileContents,
        fileStatuses: {},
      };
      const { primary, secondary } = pickInitialFiles(nextWs);
      activeWorkFileRef.current = '';
      setWorkspace(nextWs);
      setComposerPlan(null);
      setPrimaryTabs(primary ? [primary] : []);
      setPrimaryActiveFile(primary);
      setSecondaryTabs(secondary ? [secondary] : []);
      setSecondaryActiveFile(secondary);
      setCursorAgents(buildIdleAgents(10));
      setAgentOutputLogs(['Git working tree reset to clean baseline.']);
      await runScanOnWorkspace(nextWs);
    } catch (err) {
      setIdeError(err instanceof Error ? err.message : 'Git reset failed.');
    } finally {
      setIsApplying(false);
    }
  }, [runScanOnWorkspace, workspace]);

  useEffect(() => {
    // Keep 10 fixed cursors present even if a stream returns a different count.
    setCursorAgents((prev) => (prev.length === 10 ? prev : buildIdleAgents(10)));
  }, []);

  return (
    <IdeDebuggerView
      workspace={workspace}
      debugResult={debugResult}
      cursorAgents={cursorAgents}
      agentOutputLogs={agentOutputLogs}
      streamingFiles={streamingFiles}
      composerPlan={composerPlan}
      terminalHistory={terminalHistory}
      isImporting={isImporting}
      isDebugging={isDebugging}
      isSwarmFixing={isSwarmFixing}
      isBuildingFeature={isBuildingFeature}
      isApplying={isApplying}
      isRunningCommand={isRunningCommand}
      errorMsg={ideError}
      primaryTabs={primaryTabs}
      primaryActiveFile={primaryActiveFile}
      secondaryTabs={secondaryTabs}
      secondaryActiveFile={secondaryActiveFile}
      isSplitOpen={isSplitOpen}
      focusedPane={focusedPane}
      autoFollowAgent={autoFollowAgent}
      agentCount={agentCount}
      cursorSpeed={cursorSpeed}
      onChangeAgentCount={() => {}}
      onChangeCursorSpeed={setCursorSpeed}
      onToggleAutoFollow={() => setAutoFollowAgent((p) => !p)}
      onFocusPane={setFocusedPane}
      onSelectFile={(fp, pane) => openFileInPane(fp, pane ?? focusedPane)}
      onCloseTab={closeTabInPane}
      onToggleSplit={() => {
        setIsSplitOpen((prev) => {
          const next = !prev;
          if (next && !secondaryActiveFile && primaryActiveFile) {
            setSecondaryActiveFile(primaryActiveFile);
            setSecondaryTabs([primaryActiveFile]);
          }
          return next;
        });
      }}
      onCloseSecondaryPane={() => {
        setIsSplitOpen(false);
        setFocusedPane('primary');
      }}
      onImportGitHub={(repoUrl) =>
        void handleImportWorkspaceSnapshot({ source: 'github', repoUrl }, true)
      }
      onImportDemo={() => void handleImportWorkspaceSnapshot({ source: 'demo' }, true)}
      onImportWorkspace={() =>
        void handleImportWorkspaceSnapshot({ source: 'workspace' }, true)
      }
      onImportCustomFiles={(name, files) =>
        void handleImportWorkspaceSnapshot({ source: 'custom', name, files }, true)
      }
      onCreateFile={(fp) => void handleCreateFile(fp)}
      onRunScanOnly={() => {
        if (workspace) void runScanOnWorkspace(workspace);
      }}
      onRunSwarmFix={() => {
        if (workspace) void runSwarmFixOnWorkspace(workspace, agentCount, cursorSpeed);
      }}
      onRunFeatureBuild={(prompt) => {
        if (workspace) {
          void runFeatureBuildOnWorkspace(workspace, prompt, agentCount, cursorSpeed);
        }
      }}
      onRunTerminalCommand={(cmd) => void handleRunTerminalCommand(cmd)}
      onApplySingleFix={(diagnosticId) => void applyWorkspacePatch({ diagnosticId })}
      onApplyAllFixes={() => void applyWorkspacePatch({ applyAll: true })}
      onSaveManualEdit={(filePath, content) =>
        void applyWorkspacePatch({ manualEdit: { filePath, content } })
      }
      onResetGit={() => void handleResetGit()}
    />
  );
}
