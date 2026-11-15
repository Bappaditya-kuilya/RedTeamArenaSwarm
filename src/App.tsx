import { useCallback, useEffect, useRef, useState } from 'react';
import { IdeDebuggerView } from './components/IdeDebuggerView';
import { SWARM_CURSOR_PROFILES } from './engine/swarmProfiles';
import type {
  ApplyFixResponse,
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  DebugRunResponse,
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
      name: profile.name,
      color: profile.color,
      status: 'idle',
      filePath: null,
      line: 1,
      column: 1,
      task: 'Roaming workspace',
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

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [primaryTabs, setPrimaryTabs] = useState<string[]>([]);
  const [primaryActiveFile, setPrimaryActiveFile] = useState<string>('');
  const [secondaryTabs, setSecondaryTabs] = useState<string[]>([]);
  const [secondaryActiveFile, setSecondaryActiveFile] = useState<string>('');
  const [isSplitOpen, setIsSplitOpen] = useState<boolean>(false);
  const [focusedPane, setFocusedPane] = useState<'primary' | 'secondary'>('primary');

  const [debugResult, setDebugResult] = useState<DebugRunResponse | null>(null);
  const [agentCount, setAgentCount] = useState<number>(20);
  const [cursorSpeed, setCursorSpeed] = useState<CursorSpeed>('slow');
  const [cursorAgents, setCursorAgents] = useState<CursorAgentState[]>(() => buildIdleAgents(20));
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

  const openFileInPane = useCallback((filePath: string, pane: 'primary' | 'secondary' = 'primary') => {
    if (!filePath) return;
    if (pane === 'secondary') {
      setIsSplitOpen(true);
      setSecondaryActiveFile(filePath);
      setSecondaryTabs((prev) => (prev.includes(filePath) ? prev : [...prev.slice(-6), filePath]));
    } else {
      setPrimaryActiveFile(filePath);
      setPrimaryTabs((prev) => (prev.includes(filePath) ? prev : [...prev.slice(-6), filePath]));
    }
  }, []);

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
    (_agentId: string, filePath: string) => {
      if (!autoFollowRef.current || !filePath) return;
      openFileInPane(filePath, 'primary');
      setFocusedPane('primary');
    },
    [openFileInPane]
  );

  const runScanOnWorkspace = useCallback(async (ws: WorkspaceSnapshot) => {
    setIsDebugging(true);
    setIdeError(null);
    setAgentOutputLogs((prev) => [
      ...prev,
      `$ tsc --noEmit && tsx --test && static-audit (${ws.repoName})`,
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
      setDebugResult(data);
      setWorkspace((prev) =>
        prev && data.fileStatuses ? { ...prev, fileStatuses: data.fileStatuses } : prev
      );
      setAgentOutputLogs((prev) => [
        ...prev,
        `Scan complete in ${data.totalElapsedMs}ms: ${data.tscResult.errorCount} tsc errors, ${data.testResult.failed} failed tests, ${data.diagnostics.length} total problems.`,
      ]);
    } catch (err) {
      setIdeError(err instanceof Error ? err.message : 'Scan failed.');
    } finally {
      setIsDebugging(false);
    }
  }, []);

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
            setAgentOutputLogs((prev) => [...prev.slice(-160), `[${evt.phase}] ${evt.message}`]);
          } else if (evt.type === 'composer:plan') {
            setComposerPlan({
              prompt: evt.prompt,
              summary: evt.summary,
              steps: evt.steps,
            });
          } else if (evt.type === 'diagnostics:ready') {
            setDebugResult((prev) => ({
              workspaceId: ws.workspaceId,
              subagents: prev?.subagents ?? [],
              diagnostics: evt.diagnostics,
              tscResult: evt.tscResult,
              testResult: evt.testResult,
              terminalLines: prev?.terminalLines ?? [],
              gitDiff: prev?.gitDiff ?? '',
              fileStatuses: prev?.fileStatuses,
              totalElapsedMs: prev?.totalElapsedMs ?? 0,
            }));
          } else if (evt.type === 'agent:update') {
            setCursorAgents((prev) => {
              const exists = prev.some((a) => a.id === evt.agent.id);
              if (!exists) return [...prev, evt.agent];
              return prev.map((a) => (a.id === evt.agent.id ? evt.agent : a));
            });
            if (evt.logLine) {
              setAgentOutputLogs((prev) => [...prev.slice(-160), evt.logLine!]);
            }
            if (
              evt.agent.filePath &&
              ['navigating', 'writing', 'editing', 'scanning'].includes(evt.agent.status)
            ) {
              routeAgentFileToPane(evt.agent.id, evt.agent.filePath);
            }
          } else if (evt.type === 'file:streaming') {
            setStreamingFiles((prev) => ({ ...prev, [evt.filePath]: true }));
            setWorkspace((prev) => {
              if (!prev) return prev;
              const nextFiles = evt.files ?? prev.files;
              return {
                ...prev,
                files: nextFiles,
                fileContents: { ...prev.fileContents, [evt.filePath]: evt.content },
              };
            });
            routeAgentFileToPane(evt.agentId, evt.filePath);
          } else if (evt.type === 'file:created') {
            setStreamingFiles((prev) => ({ ...prev, [evt.filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    files: evt.files,
                    fileStatuses: evt.fileStatuses,
                    fileContents: { ...prev.fileContents, [evt.filePath]: evt.content },
                  }
                : prev
            );
            setComposerPlan((prev) =>
              prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.filePath === evt.filePath ? { ...s, status: 'done' } : s
                    ),
                  }
                : prev
            );
            setDebugResult((prev) =>
              prev ? { ...prev, gitDiff: evt.gitDiff, fileStatuses: evt.fileStatuses } : prev
            );
            setAgentOutputLogs((prev) => [
              ...prev.slice(-160),
              `[${evt.agentName}] Created ${evt.filePath}`,
            ]);
          } else if (evt.type === 'file:patched') {
            setStreamingFiles((prev) => ({ ...prev, [evt.filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    fileStatuses: evt.fileStatuses ?? prev.fileStatuses,
                    fileContents: { ...prev.fileContents, [evt.filePath]: evt.content },
                  }
                : prev
            );
            setComposerPlan((prev) =>
              prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s) =>
                      s.filePath === evt.filePath ? { ...s, status: 'done' } : s
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
                        ? { ...d, fixed: true, fixedByAgentId: evt.agentId, verified: true }
                        : d
                    ),
                  }
                : prev
            );
            setAgentOutputLogs((prev) => [
              ...prev.slice(-160),
              `[${evt.agentName}] Wrote ${evt.filePath}:${evt.line} -> ${evt.afterLine.trim()}`,
            ]);
          } else if (evt.type === 'file:reverted') {
            setStreamingFiles((prev) => ({ ...prev, [evt.filePath]: false }));
            setWorkspace((prev) =>
              prev
                ? {
                    ...prev,
                    fileContents: { ...prev.fileContents, [evt.filePath]: evt.content },
                  }
                : prev
            );
            setDebugResult((prev) => (prev ? { ...prev, gitDiff: evt.gitDiff } : prev));
            setAgentOutputLogs((prev) => [...prev.slice(-160), `[ROLLBACK] ${evt.reason}`]);
          } else if (evt.type === 'swarm:complete') {
            setStreamingFiles({});
            setDebugResult(evt.result);
            setCursorAgents(evt.agents);
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
          } else if (evt.type === 'error') {
            setIdeError(evt.message);
          }
        }
      }
    },
    [routeAgentFileToPane]
  );

  const runSwarmFixOnWorkspace = useCallback(
    async (ws: WorkspaceSnapshot, count: number, speed: CursorSpeed) => {
      setIsSwarmFixing(true);
      setIdeError(null);
      setIsSplitOpen(false);
      setCursorAgents(buildIdleAgents(count));
      setAgentOutputLogs([`$ swarm fix --cursors=${count} --speed=${speed} (${ws.repoName})`]);

      try {
        const resp = await fetch(`/api/repo/${ws.workspaceId}/swarm-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentCount: count, speed, useAi: true }),
        });
        await consumeSwarmSse(ws, resp);
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Swarm execution failed.');
      } finally {
        setIsSwarmFixing(false);
        setStreamingFiles({});
      }
    },
    [consumeSwarmSse]
  );

  const runFeatureBuildOnWorkspace = useCallback(
    async (ws: WorkspaceSnapshot, prompt: string, count: number, speed: CursorSpeed) => {
      setIsBuildingFeature(true);
      setIdeError(null);
      setComposerPlan(null);
      setIsSplitOpen(false);
      setCursorAgents(buildIdleAgents(count));
      setAgentOutputLogs((prev) => [
        ...prev,
        `$ swarm build "${prompt}" --cursors=${count} --speed=${speed}`,
      ]);

      try {
        const resp = await fetch(`/api/repo/${ws.workspaceId}/composer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, agentCount: count, speed, useAi: true }),
        });
        await consumeSwarmSse(ws, resp);
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Feature build failed.');
      } finally {
        setIsBuildingFeature(false);
        setStreamingFiles({});
      }
    },
    [consumeSwarmSse]
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
        setCursorAgents(buildIdleAgents(agentCountRef.current));
        setAgentOutputLogs([`Loaded ${data.repoName} (${data.files.length} files).`]);
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

  const hasBootstrappedRef = useRef(false);
  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;
    void handleImportWorkspaceSnapshot({ source: 'demo' }, true);
  }, [handleImportWorkspaceSnapshot]);

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
      setIsApplying(true);
      setIdeError(null);
      try {
        const resp = await fetch(`/api/repo/${workspace.workspaceId}/apply-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            diagnostics: debugResult?.diagnostics ?? [],
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
        setDebugResult((prev) =>
          prev
            ? {
                ...prev,
                diagnostics: data.diagnostics,
                gitDiff: data.gitDiff,
                fileStatuses: data.fileStatuses ?? prev.fileStatuses,
              }
            : prev
        );
      } catch (err) {
        setIdeError(err instanceof Error ? err.message : 'Patch write failed.');
      } finally {
        setIsApplying(false);
      }
    },
    [debugResult?.diagnostics, workspace]
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
      setWorkspace(nextWs);
      setComposerPlan(null);
      setPrimaryTabs(primary ? [primary] : []);
      setPrimaryActiveFile(primary);
      setSecondaryTabs(secondary ? [secondary] : []);
      setSecondaryActiveFile(secondary);
      setCursorAgents(buildIdleAgents(agentCount));
      setAgentOutputLogs(['Git working tree reset to clean baseline.']);
      await runScanOnWorkspace(nextWs);
    } catch (err) {
      setIdeError(err instanceof Error ? err.message : 'Git reset failed.');
    } finally {
      setIsApplying(false);
    }
  }, [agentCount, runScanOnWorkspace, workspace]);

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
      onChangeAgentCount={(count) => {
        setAgentCount(count);
        if (!isSwarmFixing && !isBuildingFeature) setCursorAgents(buildIdleAgents(count));
      }}
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
