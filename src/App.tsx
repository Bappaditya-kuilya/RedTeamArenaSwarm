import { useCallback, useEffect, useRef, useState } from 'react';
import { IdeDebuggerView } from './components/IdeDebuggerView';
import { SWARM_CURSOR_PROFILES } from './engine/swarmProfiles';
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
        const data = (await resp.json()) as DebugRunResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Subagent scan failed.');
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
        const errText = await resp.text();
        throw new Error(errText || 'Swarm stream failed.');
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
      activeWorkFileRef.current = debugResult?.diagnostics.find((d) => !d.fixed)?.filePath ?? '';
      setCursorAgents(buildIdleAgents(fixedCount));
      setAgentOutputLogs([`$ swarm fix --cursors=${fixedCount} --speed=${speed} (${ws.repoName})`]);

      try {
        const resp = await fetch(`/api/repo/${ws.workspaceId}/swarm-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentCount: fixedCount, speed, useAi: true }),
        });
        await consumeSwarmSse(ws, resp);
        // Ensure verified server-reported state after stream end.
        await runScanOnWorkspace(ws);
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Swarm execution failed.');
      } finally {
        setIsSwarmFixing(false);
        setStreamingFiles({});
        activeWorkFileRef.current = '';
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [consumeSwarmSse, debugResult?.diagnostics, runScanOnWorkspace]
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

      try {
        const resp = await fetch(`/api/repo/${ws.workspaceId}/composer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, agentCount: fixedCount, speed, useAi: true }),
        });
        await consumeSwarmSse(ws, resp);
        await runScanOnWorkspace(ws);
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Feature build failed.');
      } finally {
        setIsBuildingFeature(false);
        setStreamingFiles({});
        activeWorkFileRef.current = '';
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [consumeSwarmSse, runScanOnWorkspace]
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
        const resp = await fetch('/api/repo/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await resp.json()) as WorkspaceSnapshot & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Failed to load repository.');
        }
        const { primary, secondary } = pickInitialFiles(data);
        setWorkspace(data);
        setDebugResult(null);
        setCursorAgents(buildIdleAgents(10));
        setAgentOutputLogs([
          `Imported ${data.repoName} (${data.files.length} files) from ${data.sourceType}. Ready to scan real diagnostics.`,
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
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/create-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, content: `// ${filePath}\n` }),
        });
        const data = (await resp.json()) as {
          filePath: string;
          files: RepoFileNode[];
          fileContents: Record<string, string>;
          gitDiff: string;
          fileStatuses: Record<string, GitFileStatus>;
          error?: string;
        };
        if (!resp.ok) throw new Error(data.error || 'Failed to create file.');
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
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/run-command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        const data = (await resp.json()) as { exitCode: number; output: string; error?: string };
        if (!resp.ok) throw new Error(data.error || 'Terminal command failed.');
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
    [workspace]
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
        ? new Set(beforeDiagnostics.filter((d) => !d.fixed && d.suggestedLinePatch).map((d) => d.id))
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
          task: opts.manualEdit ? 'Applying manual edit (real backend write)' : 'Applying real backend repair',
          diagnosticId: opts.diagnosticId ?? null,
        }))
      );
      setAgentOutputLogs((prev) => [
        ...prev.slice(-180),
        opts.manualEdit
          ? `[apply-fix] real backend write for ${opts.manualEdit.filePath}`
          : `[apply-fix] real backend repair attempt (${opts.applyAll ? 'all fixable diagnostics' : opts.diagnosticId ?? 'single'})`,
      ]);
      try {
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/apply-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            diagnostics: beforeDiagnostics,
            ...opts,
          }),
        });
        const data = (await resp.json()) as ApplyFixResponse & { error?: string };
        if (!resp.ok) {
          throw new Error(data.error || 'Failed to apply fix.');
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

        // Refresh with verified results from real server scan (no optimistic fixed state).
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
        setIdeError(err instanceof Error ? err.message : 'Patch write failed.');
      } finally {
        setIsApplying(false);
        setCursorAgents(buildIdleAgents(10));
      }
    },
    [debugResult?.diagnostics, routeAgentFileToPane, runScanOnWorkspace, workspace]
  );

  const handleResetGit = useCallback(async () => {
    if (!workspace) return;
    setIsApplying(true);
    try {
      const resp = await fetch(`/api/repo/${workspace.workspaceId}/reset`, { method: 'POST' });
      const data = (await resp.json()) as {
        files: WorkspaceSnapshot['files'];
        fileContents: Record<string, string>;
        gitDiff: string;
        fileStatuses: Record<string, GitFileStatus>;
        error?: string;
      };
      if (!resp.ok) throw new Error(data.error || 'Reset failed.');
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
