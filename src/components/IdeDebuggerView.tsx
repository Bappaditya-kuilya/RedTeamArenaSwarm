import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Download,
  FilePlus2,
  Files,
  FolderMinus,
  GitBranch,
  Menu,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Play,
  RotateCcw,
  Search,
  Terminal,
  Upload,
  Wrench,
} from 'lucide-react';
import {
  buildExplorerTree,
  collectAllFolderPaths,
  searchWorkspaceFiles,
} from '../engine/fileTree';
import { generateSarifReport } from '../engine/realScanner';
import type {
  CodeDiagnostic,
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  DebugRunResponse,
  GitFileStatus,
  WorkspaceSnapshot,
} from '../types/ide';
import { ComposerPanel } from './ComposerPanel';
import { EditorPane } from './EditorPane';
import { ExplorerTree } from './ExplorerTree';
import { SwarmCursorsOverlay } from './SwarmCursorsOverlay';

export type SidebarMode = 'explorer' | 'search' | 'scm' | 'problems';

interface IdeDebuggerViewProps {
  workspace: WorkspaceSnapshot | null;
  debugResult: DebugRunResponse | null;
  cursorAgents: CursorAgentState[];
  agentOutputLogs: string[];
  streamingFiles: Record<string, boolean>;
  composerPlan: {
    prompt: string;
    summary: string;
    steps: ComposerPlanStep[];
  } | null;
  terminalHistory: Array<{ command: string; output: string; exitCode: number }>;
  isImporting: boolean;
  isDebugging: boolean;
  isSwarmFixing: boolean;
  isBuildingFeature: boolean;
  isApplying: boolean;
  isRunningCommand: boolean;
  errorMsg: string | null;
  primaryTabs: string[];
  primaryActiveFile: string;
  secondaryTabs: string[];
  secondaryActiveFile: string;
  isSplitOpen: boolean;
  focusedPane: 'primary' | 'secondary';
  autoFollowAgent: boolean;
  agentCount: number;
  cursorSpeed: CursorSpeed;
  primaryReveal?: { filePath: string; line: number; column: number; nonce: number } | null;
  secondaryReveal?: { filePath: string; line: number; column: number; nonce: number } | null;
  onChangeAgentCount: (count: number) => void;
  onChangeCursorSpeed: (speed: CursorSpeed) => void;
  onToggleAutoFollow: () => void;
  onFocusPane: (pane: 'primary' | 'secondary') => void;
  onSelectFile: (
    filePath: string,
    pane?: 'primary' | 'secondary',
    opts?: { line?: number; column?: number }
  ) => void;
  onCloseTab: (filePath: string, pane: 'primary' | 'secondary') => void;
  onToggleSplit: () => void;
  onCloseSecondaryPane: () => void;
  onImportGitHub: (repoUrl: string) => void;
  onImportDemo: () => void;
  onImportWorkspace: () => void;
  onImportCustomFiles: (name: string, files: Array<{ path: string; content: string }>) => void;
  onCreateFile: (filePath: string) => void;
  onRunScanOnly: () => void;
  onRunSwarmFix: () => void;
  onRunFeatureBuild: (prompt: string) => void;
  onRunTerminalCommand: (command: string) => void;
  onApplySingleFix: (diagnosticId: string) => void;
  onApplyAllFixes: () => void;
  onSaveManualEdit: (filePath: string, nextContent: string) => void;
  onResetGit: () => void;
}

const EMPTY_DIAGNOSTICS: CodeDiagnostic[] = [];

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function IdeDebuggerView({
  workspace,
  debugResult,
  cursorAgents,
  agentOutputLogs,
  streamingFiles,
  composerPlan,
  terminalHistory,
  isImporting,
  isDebugging,
  isSwarmFixing,
  isBuildingFeature,
  isApplying,
  isRunningCommand,
  errorMsg,
  primaryTabs,
  primaryActiveFile,
  secondaryTabs,
  secondaryActiveFile,
  isSplitOpen,
  focusedPane,
  autoFollowAgent,
  agentCount,
  cursorSpeed,
  primaryReveal,
  secondaryReveal,
  onChangeAgentCount,
  onChangeCursorSpeed,
  onToggleAutoFollow,
  onFocusPane,
  onSelectFile,
  onCloseTab,
  onToggleSplit,
  onCloseSecondaryPane,
  onImportGitHub,
  onImportDemo,
  onImportWorkspace,
  onImportCustomFiles,
  onCreateFile,
  onRunScanOnly,
  onRunSwarmFix,
  onRunFeatureBuild,
  onRunTerminalCommand,
  onApplySingleFix,
  onApplyAllFixes,
  onSaveManualEdit,
  onResetGit,
}: IdeDebuggerViewProps) {
  const [repoInput, setRepoInput] = useState('califa/swarm-site');
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('explorer');
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightComposerOpen, setRightComposerOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<'problems' | 'output' | 'terminal' | 'diff'>('problems');

  const [fileQuery, setFileQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'typescript' | 'security' | 'bug' | 'test'>('all');
  const [selectedDiagId, setSelectedDiagId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(['src', 'server']));
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [terminalCmdInput, setTerminalCmdInput] = useState('');
  const [copiedDiff, setCopiedDiff] = useState(false);

  const workbenchCanvasRef = useRef<HTMLDivElement | null>(null);
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const outputEndRef = useRef<HTMLDivElement | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);

  const diagnostics = debugResult?.diagnostics ?? EMPTY_DIAGNOSTICS;
  const fileContents = workspace?.fileContents ?? {};
  const fileStatuses: Record<string, GitFileStatus> =
    workspace?.fileStatuses ?? debugResult?.fileStatuses ?? {};

  const diagnosticsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of diagnostics) {
      if (d.fixed) continue;
      map.set(d.filePath, (map.get(d.filePath) ?? 0) + 1);
    }
    return map;
  }, [diagnostics]);

  const filteredRepoFiles = useMemo(() => {
    if (!workspace) return [];
    const q = fileQuery.trim().toLowerCase();
    return q
      ? workspace.files.filter((f) => f.path.toLowerCase().includes(q))
      : workspace.files;
  }, [workspace, fileQuery]);

  const explorerTree = useMemo(
    () => buildExplorerTree(filteredRepoFiles, diagnosticsByFile, fileStatuses),
    [filteredRepoFiles, diagnosticsByFile, fileStatuses]
  );

  useEffect(() => {
    const allFolders = collectAllFolderPaths(explorerTree);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      for (const fp of allFolders) {
        if (!fp.includes('/')) next.add(fp);
      }
      if (allFolders.includes('src')) next.add('src');
      return next;
    });
  }, [workspace?.workspaceId, workspace?.files.length]);

  useEffect(() => {
    if (bottomTab === 'output') {
      outputEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [agentOutputLogs.length, bottomTab]);

  useEffect(() => {
    if (bottomTab === 'terminal') {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [terminalHistory.length, bottomTab]);

  const searchMatches = useMemo(
    () => searchWorkspaceFiles(fileContents, searchQuery, false),
    [fileContents, searchQuery]
  );

  const filteredDiagnostics = useMemo(
    () => diagnostics.filter((d) => sourceFilter === 'all' || d.source === sourceFilter),
    [diagnostics, sourceFilter]
  );

  const handleToggleFolder = (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const handleCollapseAllFolders = () => {
    setExpandedFolders(new Set());
  };

  const handleJumpToDiagnostic = (diag: CodeDiagnostic) => {
    setSelectedDiagId(diag.id);
    onSelectFile(diag.filePath, focusedPane, { line: diag.line, column: diag.column });
  };

  const handleUploadFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const uploaded: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < Math.min(fileList.length, 25); i++) {
      const file = fileList[i];
      uploaded.push({ path: file.name, content: await file.text() });
    }
    if (uploaded.length > 0) {
      onImportCustomFiles(`uploaded/${uploaded[0].path}`, uploaded);
    }
    e.target.value = '';
  };

  const handleCreateFileSubmit = () => {
    const cleaned = newFileName.trim().replace(/^\/+/, '');
    if (!cleaned || !workspace) return;
    onCreateFile(cleaned);
    setNewFileName('');
    setIsCreatingFile(false);
  };

  const handleDownloadPatch = () => {
    if (!debugResult?.gitDiff) return;
    const slug = (workspace?.repoName || 'workspace').replace(/[^a-zA-Z0-9_-]+/g, '-');
    downloadTextFile(`${slug}.patch`, debugResult.gitDiff, 'text/x-diff');
  };

  const handleDownloadSarif = () => {
    if (!workspace || diagnostics.length === 0) return;
    const sarif = generateSarifReport(
      workspace.repoName,
      diagnostics[0].filePath,
      diagnostics.map((d) => ({
        ruleId: d.code,
        id: d.id,
        title: d.title,
        cwe: d.code,
        severity: d.severity === 'error' ? 'high' : 'medium',
        line: d.line,
        column: d.column,
        impactSummary: d.message,
      }))
    );
    const slug = workspace.repoName.replace(/[^a-zA-Z0-9_-]+/g, '-');
    downloadTextFile(`${slug}.sarif.json`, JSON.stringify(sarif, null, 2), 'application/json');
  };

  const handleCopyDiff = async () => {
    if (!debugResult?.gitDiff) return;
    try {
      await navigator.clipboard.writeText(debugResult.gitDiff);
      setCopiedDiff(true);
      window.setTimeout(() => setCopiedDiff(false), 1500);
    } catch {
      // Ignore clipboard failure
    }
  };

  const openErrorCount = diagnostics.filter((d) => !d.fixed && d.severity === 'error').length;
  const openWarningCount = diagnostics.filter((d) => !d.fixed && d.severity !== 'error').length;
  const fixedCount = diagnostics.filter((d) => d.fixed).length;
  const changedFilesCount = Object.keys(fileStatuses).length;
  const isTaskRunning = isSwarmFixing || isBuildingFeature;
  const activeFixingAgents = cursorAgents.filter((a) =>
    ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(a.status)
  ).length;
  const busy = isDebugging || isSwarmFixing || isBuildingFeature || isApplying || isImporting;

  const focusedFilePath =
    focusedPane === 'secondary' && isSplitOpen ? secondaryActiveFile : primaryActiveFile;
  const focusedCursor = cursorAgents.find((a) => a.filePath === focusedFilePath);

  const verificationOutcomes = (() => {
    if (!debugResult) return null;
    const reverted = agentOutputLogs.filter((l) => /revert|rollback/i.test(l)).length;
    const failed = agentOutputLogs.filter((l) => /failed/i.test(l)).length;
    return {
      tscErrors: debugResult.tscResult.errorCount,
      tscOk: debugResult.tscResult.errorCount === 0,
      testsRan: debugResult.testResult.ran,
      testsPassed: debugResult.testResult.passed,
      testsFailed: debugResult.testResult.failed,
      fixedCount,
      openCount: openErrorCount + openWarningCount,
      reverted,
      failedLogs: failed,
    };
  })();

  const inputBase =
    'bg-[#3c3c3c] border border-[#3c3c3c] text-[#cccccc] placeholder:text-[#858585] focus:outline-none focus:border-[#007acc] rounded-sm';

  return (
    <div
      ref={workbenchCanvasRef}
      className="relative h-screen w-screen flex flex-col bg-[#1e1e1e] text-[#cccccc] overflow-hidden select-none"
    >
      {/* Title / Command bar */}
      <header className="bg-[#3c3c3c] border-b border-[#2b2b2b] shrink-0">
        <div className="h-[35px] px-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Menu className="w-4 h-4 text-[#cccccc] opacity-80" strokeWidth={1.5} aria-hidden="true" />
            <div className="flex items-center gap-1.5 text-[13px] text-[#cccccc] truncate">
              <span className="font-medium">Swarm Workbench</span>
              <span className="text-[#969696]">—</span>
              <span className="text-[#969696] truncate">{workspace?.repoName ?? 'No Folder Opened'}</span>
            </div>
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] ${
                isTaskRunning ? 'bg-[#094771] text-[#ffffff]' : 'bg-[#2d2d2d] text-[#969696]'
              }`}
            >
              {isTaskRunning ? 'Working' : 'Idle'}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              aria-label="Toggle Primary Side Bar"
              title="Toggle Primary Side Bar"
              onClick={() => setLeftSidebarOpen((p) => !p)}
              className={`w-7 h-7 rounded inline-flex items-center justify-center transition-colors ${
                leftSidebarOpen ? 'text-[#ffffff] bg-[#505050]' : 'text-[#cccccc] hover:bg-[#505050]'
              }`}
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Toggle Panel"
              title="Toggle Panel"
              onClick={() => setBottomOpen((p) => !p)}
              className={`w-7 h-7 rounded inline-flex items-center justify-center transition-colors ${
                bottomOpen ? 'text-[#ffffff] bg-[#505050]' : 'text-[#cccccc] hover:bg-[#505050]'
              }`}
            >
              <PanelBottom className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Toggle Secondary Side Bar"
              title="Toggle Secondary Side Bar"
              onClick={() => setRightComposerOpen((p) => !p)}
              className={`w-7 h-7 rounded inline-flex items-center justify-center transition-colors ${
                rightComposerOpen ? 'text-[#ffffff] bg-[#505050]' : 'text-[#cccccc] hover:bg-[#505050]'
              }`}
            >
              <PanelRight className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Action toolbar */}
        <div className="px-2 py-2 flex flex-wrap items-stretch gap-2 border-t border-[#2b2b2b] bg-[#252526]">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (repoInput.trim()) onImportGitHub(repoInput.trim());
            }}
            className="flex-1 min-w-[320px] flex items-center gap-2"
          >
            <div className="relative flex items-center flex-1 min-w-0">
              <Search className="w-4 h-4 text-[#858585] absolute left-2 pointer-events-none" strokeWidth={1.75} aria-hidden="true" />
              <input
                id="github-repo-input"
                aria-label="GitHub repository URL or owner/repo slug"
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder="Clone repo: owner/repo or https://github.com/..."
                className={`w-full h-[28px] pl-8 pr-2 text-[13px] font-mono ${inputBase}`}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="h-[28px] px-3 text-[12px] font-medium rounded-sm bg-[#0e639c] hover:bg-[#1177bb] text-white disabled:opacity-50 whitespace-nowrap"
            >
              {isImporting ? 'Cloning…' : 'Clone'}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => fileUploadRef.current?.click()}
                className="h-[28px] px-2.5 text-[12px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-50 inline-flex items-center gap-1.5"
                title="Upload local source files"
              >
                <Upload className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                Upload
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onImportDemo}
                className="h-[28px] px-2.5 text-[12px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-50"
              >
                Demo
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onImportWorkspace}
                className="h-[28px] px-2.5 text-[12px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-50 hidden lg:inline-flex"
              >
                Workspace
              </button>
            </div>
            <input
              ref={fileUploadRef}
              type="file"
              multiple
              accept=".ts,.tsx,.js,.jsx,.mjs,.json,.html,.css,.py,.md"
              onChange={handleUploadFiles}
              className="hidden"
            />
          </form>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!workspace || busy}
              onClick={onRunScanOnly}
              title="Run real checks (tsc, tests, security/bug analysis)"
              className="h-[28px] px-3 text-[12px] font-medium rounded-sm bg-[#007acc] hover:bg-[#1f8ad2] text-white disabled:opacity-45 inline-flex items-center gap-1.5 transition-colors"
            >
              <Play className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              {isDebugging ? 'Scanning…' : 'Scan'}
            </button>

            <button
              type="button"
              disabled={!workspace || busy}
              onClick={onRunSwarmFix}
              title="Repair issues and verify with real checks"
              className="h-[28px] px-3 text-[12px] font-medium rounded-sm bg-[#0e639c] hover:bg-[#1177bb] text-white disabled:opacity-45 inline-flex items-center gap-1.5 transition-colors"
            >
              <Wrench className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              {isSwarmFixing ? 'Repairing…' : 'Repair & Verify'}
            </button>
          </div>
        </div>

        {verificationOutcomes && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 bg-[#1e1e1e] border-t border-[#2b2b2b] text-[12px] font-mono">
            <span className="text-[#969696] font-sans">Last verification:</span>
            <span className={verificationOutcomes.tscOk ? 'text-[#89d185]' : 'text-[#f14c4c]'}>
              tsc: {verificationOutcomes.tscErrors} error{verificationOutcomes.tscErrors === 1 ? '' : 's'}
            </span>
            <span className={verificationOutcomes.testsFailed === 0 ? 'text-[#89d185]' : 'text-[#f14c4c]'}>
              tests: {verificationOutcomes.testsRan ? `${verificationOutcomes.testsPassed} passed / ${verificationOutcomes.testsFailed} failed` : 'not run'}
            </span>
            <span className="text-[#cccccc]">open: {verificationOutcomes.openCount}</span>
            <span className="text-[#89d185]">fixed: {verificationOutcomes.fixedCount}</span>
            {verificationOutcomes.reverted > 0 && (
              <span className="text-[#cca700]">reverted: {verificationOutcomes.reverted}</span>
            )}
          </div>
        )}
      </header>

      {/* Main Workbench Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Activity Bar */}
        <nav
          aria-label="Activity Bar"
          className="w-[48px] bg-[#333333] flex flex-col items-center py-1 gap-0.5 shrink-0 border-r border-[#252526]"
        >
          {(
            [
              { id: 'explorer', label: 'Explorer', Icon: Files, badge: 0 },
              { id: 'search', label: 'Search', Icon: Search, badge: 0 },
              { id: 'scm', label: 'Source Control', Icon: GitBranch, badge: changedFilesCount },
              { id: 'problems', label: 'Problems', Icon: AlertCircle, badge: openErrorCount + openWarningCount },
            ] as const
          ).map(({ id, label, Icon, badge }) => {
            const active = leftSidebarOpen && sidebarMode === id;
            return (
              <button
                key={id}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => {
                  if (leftSidebarOpen && sidebarMode === id) {
                    setLeftSidebarOpen(false);
                  } else {
                    setSidebarMode(id);
                    setLeftSidebarOpen(true);
                  }
                }}
                className={`relative w-[48px] h-[48px] flex items-center justify-center transition-colors ${
                  active
                    ? 'text-[#ffffff] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-[#ffffff]'
                    : 'text-[#858585] hover:text-[#ffffff]'
                }`}
              >
                <Icon className="w-6 h-6" strokeWidth={1.5} aria-hidden="true" />
                {badge > 0 && (
                  <span className="absolute top-1.5 right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[#007acc] text-white text-[10px] font-semibold flex items-center justify-center tabular-nums">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Primary Side Bar */}
        {leftSidebarOpen && (
          <aside className="w-[260px] bg-[#252526] border-r border-[#1e1e1e] flex flex-col min-h-0 shrink-0">
            {sidebarMode === 'explorer' && (
              <>
                <div className="h-[35px] px-4 flex items-center justify-between shrink-0">
                  <span className="text-[11px] font-semibold tracking-wide uppercase text-[#bbbbbb]">
                    Explorer
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={!workspace}
                      onClick={() => setIsCreatingFile((p) => !p)}
                      aria-label="New File"
                      title="New File"
                      className="p-1 rounded text-[#cccccc] hover:bg-[#2a2d2e] disabled:opacity-40"
                    >
                      <FilePlus2 className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCollapseAllFolders}
                      aria-label="Collapse Folders in Explorer"
                      title="Collapse Folders"
                      className="p-1 rounded text-[#cccccc] hover:bg-[#2a2d2e]"
                    >
                      <FolderMinus className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="px-4 py-1 flex items-center justify-between text-[11px] font-semibold tracking-wide uppercase text-[#cccccc] bg-[#252526]">
                  <span className="truncate">{workspace?.repoName ?? 'No Folder'}</span>
                  <span className="font-mono text-[10px] font-normal text-[#969696] tabular-nums">
                    {workspace?.files.length ?? 0}
                  </span>
                </div>

                {isCreatingFile && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleCreateFileSubmit();
                    }}
                    className="px-2 py-1.5 flex items-center gap-1.5 shrink-0"
                  >
                    <input
                      autoFocus
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      placeholder="src/file.ts"
                      aria-label="New file relative path"
                      className={`flex-1 min-w-0 h-7 px-2 text-[12px] font-mono ${inputBase}`}
                    />
                    <button
                      type="submit"
                      className="h-7 px-2.5 text-[12px] bg-[#0e639c] hover:bg-[#1177bb] text-white rounded-sm"
                    >
                      Add
                    </button>
                  </form>
                )}

                <div className="px-2 py-1.5 shrink-0">
                  <input
                    type="text"
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    placeholder="Filter files…"
                    aria-label="Filter repository files"
                    className={`w-full h-7 px-2 text-[13px] ${inputBase}`}
                  />
                </div>

                <div className="flex-1 overflow-y-auto py-1">
                  {explorerTree.length > 0 ? (
                    <ExplorerTree
                      nodes={explorerTree}
                      expandedFolders={expandedFolders}
                      activeFilePath={focusedFilePath}
                      cursorAgents={cursorAgents}
                      onToggleFolder={handleToggleFolder}
                      onSelectFile={(fp) => onSelectFile(fp, focusedPane)}
                    />
                  ) : (
                    <div className="p-3 text-[13px] text-[#969696]">
                      {isImporting ? 'Reading repository…' : 'No folder opened or no matching files.'}
                    </div>
                  )}
                </div>
              </>
            )}

            {sidebarMode === 'search' && (
              <>
                <div className="h-[35px] px-4 flex items-center justify-between shrink-0">
                  <span className="text-[11px] font-semibold tracking-wide uppercase text-[#bbbbbb]">Search</span>
                  <span className="text-[11px] font-mono text-[#969696] tabular-nums">{searchMatches.length}</span>
                </div>
                <div className="p-2 shrink-0">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search"
                    aria-label="Search text across workspace files"
                    className={`w-full h-7 px-2 text-[13px] ${inputBase}`}
                  />
                </div>
                <div className="flex-1 overflow-y-auto">
                  {!searchQuery.trim() ? (
                    <div className="p-3 text-[13px] text-[#969696]">
                      Type to search across all files in the workspace.
                    </div>
                  ) : searchMatches.length === 0 ? (
                    <div className="p-3 text-[13px] text-[#969696]">No results found.</div>
                  ) : (
                    searchMatches.map((m, idx) => (
                      <button
                        key={`${m.filePath}-${m.line}-${m.column}-${idx}`}
                        type="button"
                        onClick={() => onSelectFile(m.filePath, focusedPane, { line: m.line, column: m.column })}
                        className="w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e] focus:bg-[#094771]/30 focus:outline-none space-y-0.5 border-b border-[#2b2b2b]"
                      >
                        <div className="flex items-center justify-between text-[12px] font-mono text-[#3794ff]">
                          <span className="truncate">{m.filePath}</span>
                          <span className="text-[#969696] shrink-0">:{m.line}:{m.column}</span>
                        </div>
                        <div className="text-[12px] font-mono text-[#cccccc] truncate">
                          {m.lineText.trim()}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}

            {sidebarMode === 'scm' && (
              <>
                <div className="h-[35px] px-4 flex items-center justify-between shrink-0">
                  <span className="text-[11px] font-semibold tracking-wide uppercase text-[#bbbbbb]">
                    Source Control
                  </span>
                  {debugResult?.gitDiff && (
                    <button
                      type="button"
                      onClick={onResetGit}
                      className="text-[12px] text-[#cccccc] hover:bg-[#2a2d2e] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                    >
                      <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Discard
                    </button>
                  )}
                </div>

                <div className="px-2 py-2 flex flex-wrap gap-1.5 shrink-0 border-b border-[#1e1e1e]">
                  <button
                    type="button"
                    disabled={!debugResult?.gitDiff}
                    onClick={() => {
                      setBottomOpen(true);
                      setBottomTab('diff');
                    }}
                    className="px-2.5 py-1 text-[12px] rounded-sm bg-[#0e639c] hover:bg-[#1177bb] text-white disabled:opacity-40"
                  >
                    Open Diff
                  </button>
                  <button
                    type="button"
                    disabled={!debugResult?.gitDiff}
                    onClick={handleDownloadPatch}
                    className="px-2 py-1 text-[12px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    .patch
                  </button>
                  <button
                    type="button"
                    disabled={diagnostics.length === 0}
                    onClick={handleDownloadSarif}
                    className="px-2 py-1 text-[12px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    SARIF
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto py-1">
                  {changedFilesCount === 0 ? (
                    <div className="p-3 text-[13px] text-[#969696]">
                      No changes. Run a scan or repair to produce tracked changes.
                    </div>
                  ) : (
                    Object.entries(fileStatuses).map(([fp, st]) => (
                      <button
                        key={fp}
                        type="button"
                        onClick={() => {
                          onSelectFile(fp, focusedPane);
                          setBottomOpen(true);
                          setBottomTab('diff');
                        }}
                        className="w-full px-3 py-1 text-left text-[13px] font-mono flex items-center justify-between hover:bg-[#2a2d2e]"
                      >
                        <span className={`truncate ${st === 'A' ? 'text-[#81b88b]' : 'text-[#e2c08d]'}`}>
                          {fp}
                        </span>
                        <span className={`font-semibold ${st === 'A' ? 'text-[#81b88b]' : 'text-[#e2c08d]'}`}>
                          {st}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}

            {sidebarMode === 'problems' && (
              <>
                <div className="h-[35px] px-4 flex items-center justify-between shrink-0">
                  <span className="text-[11px] font-semibold tracking-wide uppercase text-[#bbbbbb]">
                    Problems ({filteredDiagnostics.length})
                  </span>
                  {diagnostics.some((d) => !d.fixed && (d.suggestedLinePatch || d.suggestedFilePatch)) && (
                    <button
                      type="button"
                      disabled={isApplying || isSwarmFixing}
                      onClick={onApplyAllFixes}
                      className="text-[12px] text-[#3794ff] hover:underline disabled:opacity-50"
                      title="Apply available suggested repairs"
                    >
                      Fix All
                    </button>
                  )}
                </div>

                <div className="px-2 py-1.5 flex items-center gap-1 overflow-x-auto shrink-0 border-b border-[#1e1e1e]">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'typescript', label: 'TSC' },
                      { id: 'test', label: 'Tests' },
                      { id: 'security', label: 'Security' },
                      { id: 'bug', label: 'Bugs' },
                    ] as const
                  ).map((flt) => (
                    <button
                      key={flt.id}
                      type="button"
                      onClick={() => setSourceFilter(flt.id)}
                      className={`px-2 py-0.5 text-[12px] rounded-sm whitespace-nowrap transition-colors ${
                        sourceFilter === flt.id
                          ? 'bg-[#094771] text-[#ffffff]'
                          : 'text-[#cccccc] hover:bg-[#2a2d2e]'
                      }`}
                    >
                      {flt.label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto">
                  {filteredDiagnostics.length === 0 ? (
                    <div className="p-3 text-[13px] text-[#969696]">
                      No problems detected. Run <b>Scan</b> to collect results.
                    </div>
                  ) : (
                    filteredDiagnostics.map((diag) => (
                      <div
                        key={diag.id}
                        className={`p-2.5 space-y-1 border-b border-[#2b2b2b] hover:bg-[#2a2d2e] ${
                          selectedDiagId === diag.id ? 'bg-[#094771]/30' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleJumpToDiagnostic(diag)}
                          className="w-full text-left space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className={`px-1.5 py-0.5 rounded uppercase ${
                                  diag.source === 'ai' ? 'bg-[#4b2a63] text-[#e1bfff]' : 'bg-[#1e3a1e] text-[#89d185]'
                                }`}
                              >
                                {diag.source === 'ai' ? 'heuristic' : 'verified'}
                              </span>
                              <span
                                className={
                                  diag.fixed
                                    ? 'text-[#89d185]'
                                    : diag.severity === 'error'
                                    ? 'text-[#f14c4c]'
                                    : 'text-[#cca700]'
                                }
                              >
                                {diag.severity}
                              </span>
                            </span>
                            <span className="text-[#969696] truncate">{diag.filePath}:{diag.line}</span>
                          </div>
                          <div className="text-[13px] text-[#cccccc] leading-snug">
                            [{diag.code}] {diag.title}
                          </div>
                          <p className="text-[12px] text-[#969696] leading-snug line-clamp-2">{diag.message}</p>
                        </button>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className={diag.fixed ? 'text-[#89d185]' : 'text-[#969696]'}>
                            {diag.fixed ? (diag.verified ? 'Fixed · verified' : 'Fixed') : 'Open'}
                          </span>
                          {!diag.fixed && (diag.suggestedLinePatch || diag.suggestedFilePatch) && (
                            <button
                              type="button"
                              disabled={isApplying || isSwarmFixing}
                              onClick={() => onApplySingleFix(diag.id)}
                              className="px-2 py-0.5 bg-[#094771] hover:bg-[#0e639c] text-white rounded-sm transition-colors"
                            >
                              Quick Fix
                            </button>
                          )}
                        </div>
                        {selectedDiagId === diag.id && (
                          <div className="mt-1 p-2 rounded bg-[#1e1e1e] border border-[#2b2b2b] space-y-1.5 text-[12px]">
                            <div><span className="text-[#cccccc] font-medium">Evidence:</span> <span className="text-[#969696] whitespace-pre-wrap">{diag.explanation || diag.message}</span></div>
                            {diag.originalLine && (
                              <div><span className="text-[#cccccc] font-medium">Original:</span> <code className="font-mono text-[#f48771] break-all">{diag.originalLine}</code></div>
                            )}
                            {diag.suggestedLinePatch && (
                              <div><span className="text-[#cccccc] font-medium">Suggested:</span> <code className="font-mono text-[#89d185] break-all">{diag.suggestedLinePatch}</code></div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </aside>
        )}

        {/* Editor area + bottom panel */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#1e1e1e]">
          {errorMsg && (
            <div
              role="alert"
              className="px-3 py-1.5 bg-[#5a1d1d] border-b border-[#f14c4c]/40 text-[13px] text-[#f48771] shrink-0"
            >
              {errorMsg}
            </div>
          )}

          <div className="flex-1 flex min-h-0 overflow-hidden">
            <EditorPane
              paneId="primary"
              isFocused={focusedPane === 'primary' || !isSplitOpen}
              isSplitActive={isSplitOpen}
              tabs={primaryTabs}
              activeFilePath={primaryActiveFile}
              fileContents={fileContents}
              fileStatuses={fileStatuses}
              diagnostics={diagnostics}
              cursorAgents={cursorAgents}
              streamingFiles={streamingFiles}
              selectedDiagId={selectedDiagId}
              revealTarget={primaryReveal}
              onFocusPane={() => onFocusPane('primary')}
              onSelectFile={(fp) => onSelectFile(fp, 'primary')}
              onCloseTab={(fp) => onCloseTab(fp, 'primary')}
              onSplitRight={onToggleSplit}
              onSelectDiagnostic={handleJumpToDiagnostic}
              onApplySingleFix={onApplySingleFix}
              onSaveManualEdit={onSaveManualEdit}
              onResetGit={onResetGit}
              hasGitDiff={Boolean(debugResult?.gitDiff)}
              busy={busy}
            />

            {isSplitOpen && (
              <EditorPane
                paneId="secondary"
                isFocused={focusedPane === 'secondary'}
                isSplitActive={isSplitOpen}
                tabs={secondaryTabs}
                activeFilePath={secondaryActiveFile}
                fileContents={fileContents}
                fileStatuses={fileStatuses}
                diagnostics={diagnostics}
                cursorAgents={cursorAgents}
                streamingFiles={streamingFiles}
                selectedDiagId={selectedDiagId}
                revealTarget={secondaryReveal}
                onFocusPane={() => onFocusPane('secondary')}
                onSelectFile={(fp) => onSelectFile(fp, 'secondary')}
                onCloseTab={(fp) => onCloseTab(fp, 'secondary')}
                onClosePane={onCloseSecondaryPane}
                onSelectDiagnostic={handleJumpToDiagnostic}
                onApplySingleFix={onApplySingleFix}
                onSaveManualEdit={onSaveManualEdit}
                busy={busy}
              />
            )}
          </div>

          {/* Bottom Panel */}
          <section className="border-t border-[#2b2b2b] bg-[#1e1e1e] flex flex-col shrink-0">
            <div className="h-[35px] px-2 bg-[#252526] flex items-center justify-between border-b border-[#1e1e1e]">
              <div className="flex items-center gap-0 text-[13px]">
                {(
                  [
                    { id: 'problems', label: `PROBLEMS`, suffix: ` ${openErrorCount + openWarningCount}` },
                    { id: 'output', label: 'OUTPUT', suffix: '' },
                    { id: 'terminal', label: 'TERMINAL', suffix: '' },
                    { id: 'diff', label: 'DIFF', suffix: changedFilesCount ? ` ${changedFilesCount}` : '' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setBottomOpen(true);
                      setBottomTab(tab.id);
                    }}
                    className={`px-3 h-[35px] uppercase text-[11px] tracking-wide border-b transition-colors ${
                      bottomOpen && bottomTab === tab.id
                        ? 'border-[#ffffff] text-[#ffffff]'
                        : 'border-transparent text-[#969696] hover:text-[#cccccc]'
                    }`}
                  >
                    {tab.label}{tab.suffix}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setBottomOpen((p) => !p)}
                className="p-1 text-[#cccccc] hover:bg-[#2a2d2e] rounded"
                title={bottomOpen ? 'Hide Panel' : 'Show Panel'}
              >
                <PanelBottom className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>

            {bottomOpen && (
              <div className="h-[200px] overflow-y-auto bg-[#1e1e1e] font-mono text-[12px]">
                {bottomTab === 'problems' && (
                  <div>
                    {diagnostics.length === 0 ? (
                      <div className="p-3 text-[#969696] font-sans text-[13px]">
                        No problems have been detected in the workspace.
                      </div>
                    ) : (
                      diagnostics.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => handleJumpToDiagnostic(d)}
                          className="w-full px-3 py-1.5 text-left hover:bg-[#2a2d2e] flex items-start gap-2 border-b border-[#2b2b2b]/50"
                        >
                          {d.fixed ? (
                            <Check className="w-4 h-4 text-[#89d185] shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
                          ) : d.severity === 'error' ? (
                            <AlertCircle className="w-4 h-4 text-[#f14c4c] shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-[#cca700] shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className={`truncate ${d.fixed ? 'text-[#969696] line-through' : 'text-[#cccccc]'}`}>
                              {d.message} <span className="text-[#858585]">[{d.code}]</span>
                            </div>
                            <div className="text-[11px] text-[#969696] truncate">
                              {d.filePath} [{d.line}, {d.column}] · {d.source === 'ai' ? 'heuristic' : 'verified'}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {bottomTab === 'output' && (
                  <div className="p-3 space-y-1">
                    <div className="text-[11px] font-sans uppercase tracking-wide text-[#969696] mb-1">Swarm Activity Log</div>
                    {agentOutputLogs.length === 0 ? (
                      <div className="text-[#969696] font-sans text-[13px]">No activity yet.</div>
                    ) : (
                      agentOutputLogs.map((line, i) => (
                        <div
                          key={`${i}-${line.slice(0, 12)}`}
                          className={
                            /fixed|verified|wrote|created|done|passed/i.test(line)
                              ? 'text-[#89d185]'
                              : /rollback|revert|failed|error/i.test(line)
                              ? 'text-[#f48771]'
                              : line.startsWith('$')
                              ? 'text-[#3794ff]'
                              : 'text-[#cccccc]'
                          }
                        >
                          {line}
                        </div>
                      ))
                    )}
                    <div ref={outputEndRef} />
                  </div>
                )}

                {bottomTab === 'terminal' && (
                  <div className="h-full flex flex-col">
                    <div className="px-3 py-1 border-b border-[#2b2b2b] bg-[#252526] flex items-center justify-between gap-2 shrink-0">
                      <div className="flex items-center gap-2 text-[12px]">
                        <Terminal className="w-4 h-4 text-[#cccccc]" strokeWidth={1.75} aria-hidden="true" />
                        <span className="text-[#cccccc] font-sans">{workspace?.repoName ?? 'workspace'}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {(['tsc --noEmit', 'tsx --test', 'git status'] as const).map((presetCmd) => (
                          <button
                            key={presetCmd}
                            type="button"
                            disabled={!workspace || isRunningCommand}
                            onClick={() => onRunTerminalCommand(presetCmd)}
                            className="px-2 py-0.5 text-[11px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] disabled:opacity-45"
                          >
                            {presetCmd}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                      {debugResult && (
                        <div className="space-y-1">
                          <div className="text-[#969696] font-sans text-[11px] uppercase tracking-wide">Scan Results</div>
                          <div className={debugResult.tscResult.errorCount === 0 ? 'text-[#89d185]' : 'text-[#f48771]'}>
                            [tsc] errors={debugResult.tscResult.errorCount} warnings={debugResult.tscResult.warningCount}
                          </div>
                          <pre className="whitespace-pre-wrap break-words text-[#cccccc]">{debugResult.tscResult.output || '(no output)'}</pre>
                          <div className={debugResult.testResult.failed === 0 ? 'text-[#89d185]' : 'text-[#f48771]'}>
                            [{debugResult.testResult.command || 'tests'}] passed={debugResult.testResult.passed} failed={debugResult.testResult.failed} exit={debugResult.testResult.exitCode}
                          </div>
                          {debugResult.testResult.output && (
                            <pre className="whitespace-pre-wrap break-words text-[#cccccc]">{debugResult.testResult.output}</pre>
                          )}
                        </div>
                      )}

                      {terminalHistory.map((item, idx) => (
                        <div key={idx} className="space-y-0.5">
                          <div className="text-[#3794ff]">$ {item.command}</div>
                          <pre
                            className={`whitespace-pre-wrap break-words ${
                              item.exitCode === 0 ? 'text-[#cccccc]' : 'text-[#f48771]'
                            }`}
                          >
                            {item.output}
                          </pre>
                        </div>
                      ))}
                      <div ref={terminalEndRef} />
                    </div>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const cmd = terminalCmdInput.trim();
                        if (!cmd || !workspace || isRunningCommand) return;
                        onRunTerminalCommand(cmd);
                        setTerminalCmdInput('');
                      }}
                      className="px-3 py-1.5 border-t border-[#2b2b2b] bg-[#1e1e1e] flex items-center gap-2 shrink-0"
                    >
                      <span className="text-[#3794ff] font-semibold">$</span>
                      <input
                        type="text"
                        value={terminalCmdInput}
                        onChange={(e) => setTerminalCmdInput(e.target.value)}
                        placeholder="Run a command (tsc, tsx --test, git status, …)"
                        aria-label="Workspace terminal command"
                        className="flex-1 bg-transparent text-[#cccccc] placeholder:text-[#858585] focus:outline-none text-[13px]"
                      />
                    </form>
                  </div>
                )}

                {bottomTab === 'diff' && (
                  <div className="p-3 space-y-2">
                    <div className="flex items-center justify-between pb-1.5 border-b border-[#2b2b2b]">
                      <span className="text-[#969696] font-sans text-[12px]">
                        git diff ({changedFilesCount} changed file{changedFilesCount === 1 ? '' : 's'})
                      </span>
                      <button
                        type="button"
                        disabled={!debugResult?.gitDiff}
                        onClick={handleCopyDiff}
                        className="px-2 py-0.5 text-[11px] rounded-sm bg-[#3c3c3c] hover:bg-[#4c4c4c] text-[#cccccc] inline-flex items-center gap-1 disabled:opacity-40"
                      >
                        {copiedDiff ? <Check className="w-3.5 h-3.5 text-[#89d185]" strokeWidth={1.75} /> : <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />}
                        {copiedDiff ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    {!debugResult?.gitDiff ? (
                      <div className="text-[#969696] font-sans text-[13px]">No changes.</div>
                    ) : (
                      <pre className="space-y-0">
                        {debugResult.gitDiff.split('\n').map((l, idx) => {
                          let cls = 'text-[#cccccc]';
                          if (l.startsWith('+') && !l.startsWith('+++')) cls = 'bg-[#1e3a1e]/50 text-[#89d185]';
                          else if (l.startsWith('-') && !l.startsWith('---')) cls = 'bg-[#5a1d1d]/40 text-[#f48771]';
                          else if (l.startsWith('@@')) cls = 'text-[#569cd6]';
                          else if (l.startsWith('diff --git')) cls = 'text-[#ffffff] font-semibold';
                          return (
                            <div key={idx} className={`px-1 ${cls}`}>
                              {l || ' '}
                            </div>
                          );
                        })}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right Secondary Side Bar */}
        {rightComposerOpen && (
          <ComposerPanel
            agentCount={agentCount}
            cursorSpeed={cursorSpeed}
            autoFollowAgent={autoFollowAgent}
            isSwarmFixing={isSwarmFixing}
            isBuildingFeature={isBuildingFeature}
            isImporting={isImporting}
            hasWorkspace={Boolean(workspace)}
            openProblemCount={openErrorCount + openWarningCount}
            cursorAgents={cursorAgents}
            composerPlan={composerPlan}
            fileStatuses={fileStatuses}
            onChangeAgentCount={onChangeAgentCount}
            onChangeCursorSpeed={onChangeCursorSpeed}
            onToggleAutoFollow={onToggleAutoFollow}
            onRunSwarmFix={onRunSwarmFix}
            onRunFeatureBuild={onRunFeatureBuild}
            onJumpToFile={(fp) => onSelectFile(fp, focusedPane)}
            onShowDiff={() => {
              setBottomOpen(true);
              setBottomTab('diff');
            }}
          />
        )}
      </div>

      {/* Status Bar */}
      <footer className="h-[22px] bg-[#007acc] text-white flex items-center justify-between text-[12px] shrink-0 select-none">
        <div className="flex items-center h-full">
          <div className="h-full px-2.5 bg-[#16825d] flex items-center gap-1.5 hover:brightness-110 cursor-default">
            <span className="font-medium">Swarm</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setBottomOpen(true);
              setBottomTab('diff');
              setSidebarMode('scm');
              setLeftSidebarOpen(true);
            }}
            className="h-full px-2 flex items-center gap-1.5 hover:bg-[#1f8ad2]"
            title="Source Control"
          >
            <GitBranch className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            <span>{workspace?.branch ?? 'main'}</span>
            {changedFilesCount > 0 && <span>*</span>}
          </button>
          <button
            type="button"
            onClick={() => {
              setBottomOpen(true);
              setBottomTab('problems');
            }}
            className="h-full px-2 flex items-center gap-2 hover:bg-[#1f8ad2]"
            title="Problems"
          >
            <span className="inline-flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              {openErrorCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              {openWarningCount}
            </span>
          </button>
          {activeFixingAgents > 0 ? (
            <span className="px-2 h-full flex items-center gap-1.5 hover:bg-[#1f8ad2]">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              {activeFixingAgents} cursor{activeFixingAgents === 1 ? '' : 's'} active
            </span>
          ) : (
            <span className="px-2 h-full hidden md:flex items-center text-white/90">
              {agentCount} cursors ready
            </span>
          )}
        </div>

        <div className="flex items-center h-full">
          {debugResult && (
            <span className="px-2 h-full hidden lg:flex items-center hover:bg-[#1f8ad2]">
              tsc {debugResult.tscResult.errorCount} · tests {debugResult.testResult.passed}/{debugResult.testResult.failed}
            </span>
          )}
          <span className="px-2 h-full flex items-center hover:bg-[#1f8ad2]">
            Ln {focusedCursor?.line ?? 1}, Col {focusedCursor?.column ?? 1}
          </span>
          <span className="px-2 h-full hidden sm:flex items-center hover:bg-[#1f8ad2]">Spaces: 2</span>
          <span className="px-2 h-full hidden sm:flex items-center hover:bg-[#1f8ad2]">UTF-8</span>
          <span className="px-2 h-full hidden sm:flex items-center hover:bg-[#1f8ad2]">TypeScript JSX</span>
          <span className="px-2 h-full hidden md:flex items-center hover:bg-[#1f8ad2]" title="Notifications">
            <span className="inline-flex items-center gap-1">
              <Check className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              {fixedCount}
            </span>
          </span>
        </div>
      </footer>

      {/* Live 10-Cursor Animated Pointer Swarm Overlay */}
      <SwarmCursorsOverlay
        agents={cursorAgents}
        activeFilePath={primaryActiveFile}
        isTaskRunning={isTaskRunning}
        speed={cursorSpeed}
        containerRef={workbenchCanvasRef}
      />
    </div>
  );
}
