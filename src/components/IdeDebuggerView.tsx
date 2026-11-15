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
  onChangeAgentCount: (count: number) => void;
  onChangeCursorSpeed: (speed: CursorSpeed) => void;
  onToggleAutoFollow: () => void;
  onFocusPane: (pane: 'primary' | 'secondary') => void;
  onSelectFile: (filePath: string, pane?: 'primary' | 'secondary') => void;
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
const RULER_TICKS = Array.from({ length: 18 }, (_, i) => i * 100);

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
    onSelectFile(diag.filePath, focusedPane);
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

  return (
    <div
      ref={workbenchCanvasRef}
      className="relative h-screen w-screen flex flex-col bg-[#F8F9FA] text-[#121417] overflow-hidden select-none"
    >
      {/* Subtle Figma-style Top Pixel Ruler inspired by califa/swarm-site */}
      <div
        aria-hidden="true"
        className="h-[16px] bg-[#2C2C2C] border-b border-[#3A3A3A] px-5 flex items-center justify-between text-[9px] font-mono text-[#8C8C8C] shrink-0"
      >
        <div className="flex items-center overflow-hidden gap-12">
          {RULER_TICKS.map((tick) => (
            <span key={tick} className="inline-flex items-center gap-1 shrink-0">
              <span className="w-px h-2 bg-[#5E5E5E]" />
              <span>{tick}</span>
            </span>
          ))}
        </div>
        <span className="text-[#0D99FF] font-medium shrink-0">
          {isTaskRunning ? `CONVERGED · ${agentCount} CURSORS` : `ROAMING · ${agentCount} CURSORS`}
        </span>
      </div>

      {/* Swarm Canvas Header */}
      <header className="h-[48px] bg-[#F8F9FA] border-b border-[#E0E2E5] px-3 flex items-center justify-between gap-3 shrink-0">
        {/* Left: Swarm Emblem + Brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-[6px] bg-[#121417] flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <path
                  d="M5 6.5C5 5.1 6.1 4 7.5 4H16.5C17.3 4 18 4.7 18 5.5C18 6.3 17.3 7 16.5 7H9.5L15.8 11.5C16.9 12.3 17 13.8 16.1 14.8L13.5 17.5C13 18 12.2 18 11.5 18H5.5C4.7 18 4 17.3 4 16.5C4 15.7 4.7 15 5.5 15H12.5L6.2 10.5C5.4 9.9 5 8.9 5 7.9V6.5Z"
                  fill="#FFFFFF"
                />
              </svg>
            </div>
            <span className="font-display text-[15px] font-semibold tracking-[-0.02em] text-[#121417] whitespace-nowrap">
              Swarm
            </span>
          </div>
          <span className="hidden xl:inline-flex items-center px-2 py-0.5 rounded-[4px] bg-[#E6F4FF] text-[#0D99FF] text-[11px] font-medium">
            {cursorAgents.length} Cursors
          </span>
        </div>

        {/* Center: Real GitHub Repo Loader & Presets */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (repoInput.trim()) onImportGitHub(repoInput.trim());
          }}
          className="flex items-center gap-1.5 flex-1 max-w-2xl min-w-0"
        >
          <div className="flex-1 min-w-[140px] relative flex items-center">
            <Search
              className="w-3.5 h-3.5 text-[#6B7078] absolute left-2.5 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="github-repo-input"
              aria-label="GitHub repository URL or owner/repo slug"
              type="text"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="Clone any GitHub repo (owner/repo or https://github.com/...)"
              className="w-full h-[32px] pl-8 pr-2.5 text-[12px] font-mono rounded-[6px] bg-[#FFFFFF] border border-[#E0E2E5] text-[#121417] placeholder:text-[#6B7078] focus:outline-none focus:border-[#0D99FF]"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="h-[32px] px-3 text-[12px] font-medium rounded-[6px] bg-[#FFFFFF] hover:bg-[#121417] text-[#121417] hover:text-white border border-[#E0E2E5] disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors"
          >
            {isImporting ? 'Cloning…' : 'Clone Repo'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onImportDemo}
            className={`h-[32px] px-2.5 text-[12px] font-medium rounded-[6px] border whitespace-nowrap shrink-0 transition-colors ${
              workspace?.sourceType === 'demo'
                ? 'bg-[#E6F4FF] text-[#0D99FF] border-[#0D99FF]/50'
                : 'bg-[#FFFFFF] hover:bg-[#F1F3F5] text-[#30343A] border-[#E0E2E5]'
            }`}
          >
            Demo TS
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRepoInput('califa/swarm-site');
              onImportGitHub('califa/swarm-site');
            }}
            className="h-[32px] px-2.5 text-[12px] font-medium rounded-[6px] bg-[#FFFFFF] hover:bg-[#F1F3F5] text-[#30343A] border border-[#E0E2E5] disabled:opacity-50 whitespace-nowrap shrink-0 hidden md:inline-flex items-center transition-colors"
          >
            califa/swarm-site
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onImportWorkspace}
            className={`h-[32px] px-2.5 text-[12px] font-medium rounded-[6px] border disabled:opacity-50 whitespace-nowrap shrink-0 hidden lg:inline-flex items-center transition-colors ${
              workspace?.sourceType === 'workspace'
                ? 'bg-[#E6F4FF] text-[#0D99FF] border-[#0D99FF]/50'
                : 'bg-[#FFFFFF] hover:bg-[#F1F3F5] text-[#30343A] border-[#E0E2E5]'
            }`}
          >
            This Workspace
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileUploadRef.current?.click()}
            className="h-[32px] px-2.5 text-[12px] font-medium rounded-[6px] bg-[#FFFFFF] hover:bg-[#F1F3F5] text-[#30343A] border border-[#E0E2E5] disabled:opacity-50 whitespace-nowrap shrink-0 inline-flex items-center gap-1 transition-colors"
            title="Upload local source files"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            Upload
          </button>
          <input
            ref={fileUploadRef}
            type="file"
            multiple
            accept=".ts,.tsx,.js,.jsx,.mjs,.json,.html,.css,.py,.md"
            onChange={handleUploadFiles}
            className="hidden"
          />
        </form>

        {/* Right: Primary Actions & Workbench Toggles */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={!workspace || busy}
            onClick={onRunScanOnly}
            title="Scan repository diagnostics (tsc + tests + AST + security)"
            className="h-[32px] px-2.5 text-[12px] font-medium rounded-[6px] bg-[#FFFFFF] hover:bg-[#F1F3F5] border border-[#E0E2E5] text-[#121417] disabled:opacity-45 inline-flex items-center gap-1.5 shrink-0 transition-colors"
          >
            <Play className="w-3.5 h-3.5 text-[#0D99FF]" aria-hidden="true" />
            <span className="hidden sm:inline">{isDebugging ? 'Scanning…' : 'Scan'}</span>
          </button>

          <button
            type="button"
            disabled={!workspace || busy}
            onClick={onRunSwarmFix}
            className="h-[32px] px-3.5 text-[12px] font-semibold rounded-[6px] bg-[#121417] hover:bg-[#30343A] text-white disabled:opacity-45 whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 transition-colors"
          >
            <Wrench className="w-3.5 h-3.5 text-[#0D99FF]" aria-hidden="true" />
            <span>
              {isSwarmFixing ? `Converged (${activeFixingAgents})…` : 'Auto-Fix All'}
            </span>
          </button>

          <div className="h-4 w-px bg-[#E0E2E5] mx-0.5 hidden sm:block" />

          <button
            type="button"
            aria-label="Toggle Primary Side Bar"
            title="Toggle Primary Side Bar"
            onClick={() => setLeftSidebarOpen((p) => !p)}
            className={`w-7 h-7 rounded-[6px] inline-flex items-center justify-center transition-colors ${
              leftSidebarOpen
                ? 'text-[#0D99FF] bg-[#E6F4FF]'
                : 'text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/50'
            }`}
          >
            <PanelLeft className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Toggle Bottom Panel"
            title="Toggle Bottom Panel"
            onClick={() => setBottomOpen((p) => !p)}
            className={`w-7 h-7 rounded-[6px] inline-flex items-center justify-center transition-colors ${
              bottomOpen
                ? 'text-[#0D99FF] bg-[#E6F4FF]'
                : 'text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/50'
            }`}
          >
            <PanelBottom className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Toggle Swarm Task Panel"
            title="Toggle Swarm Task Panel"
            onClick={() => setRightComposerOpen((p) => !p)}
            className={`w-7 h-7 rounded-[6px] inline-flex items-center justify-center transition-colors ${
              rightComposerOpen
                ? 'text-[#0D99FF] bg-[#E6F4FF]'
                : 'text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/50'
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Main Workbench Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Activity Bar */}
        <nav
          aria-label="Activity Bar"
          className="w-12 bg-[#F8F9FA] border-r border-[#E0E2E5] flex flex-col items-center py-2 gap-1 shrink-0"
        >
          {(
            [
              { id: 'explorer', label: 'Explorer', Icon: Files, badge: 0 },
              { id: 'search', label: 'Search', Icon: Search, badge: 0 },
              {
                id: 'scm',
                label: 'Source Control',
                Icon: GitBranch,
                badge: changedFilesCount,
              },
              {
                id: 'problems',
                label: 'Problems',
                Icon: AlertCircle,
                badge: openErrorCount + openWarningCount,
              },
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
                className={`relative w-9 h-9 rounded-[6px] flex items-center justify-center transition-colors ${
                  active
                    ? 'bg-[#E6F4FF] text-[#0D99FF]'
                    : 'text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60'
                }`}
              >
                <Icon className="w-[18px] h-[18px] stroke-[1.75]" aria-hidden="true" />
                {badge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#0D99FF] text-white text-[9.5px] font-mono font-semibold flex items-center justify-center tabular-nums">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Primary Left Sidebar */}
        {leftSidebarOpen && (
          <aside className="w-[228px] bg-[#FFFFFF] border-r border-[#E0E2E5] flex flex-col min-h-0 shrink-0">
            {sidebarMode === 'explorer' && (
              <>
                <div className="h-[36px] px-3 bg-[#F8F9FA] flex items-center justify-between border-b border-[#E0E2E5] shrink-0">
                  <span className="text-[11.5px] font-semibold text-[#121417] truncate">
                    Explorer
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={!workspace}
                      onClick={() => setIsCreatingFile((p) => !p)}
                      aria-label="New File"
                      title="New File"
                      className="p-1 rounded-[4px] text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60 disabled:opacity-40"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCollapseAllFolders}
                      aria-label="Collapse Folders in Explorer"
                      title="Collapse Folders"
                      className="p-1 rounded-[4px] text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60"
                    >
                      <FolderMinus className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="h-[26px] px-3 bg-[#FFFFFF] border-b border-[#E0E2E5] flex items-center justify-between text-[11px] font-semibold tracking-tight text-[#30343A] shrink-0">
                  <span className="truncate">{workspace?.repoName ?? 'No Workspace'}</span>
                  <span className="font-mono text-[10.5px] font-medium text-[#6B7078] tabular-nums">
                    {workspace?.files.length ?? 0}
                  </span>
                </div>

                {isCreatingFile && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleCreateFileSubmit();
                    }}
                    className="p-2 border-b border-[#E0E2E5] bg-[#F8F9FA] flex items-center gap-1.5 shrink-0"
                  >
                    <input
                      autoFocus
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      placeholder="src/helper.ts"
                      aria-label="New file relative path"
                      className="flex-1 min-w-0 h-7 px-2 text-[11.5px] font-mono rounded-[6px] bg-[#FFFFFF] border border-[#0D99FF] text-[#121417] focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="h-7 px-2.5 text-[11px] font-medium bg-[#121417] text-white rounded-[6px]"
                    >
                      Create
                    </button>
                  </form>
                )}

                <div className="px-2 py-2 border-b border-[#E0E2E5] shrink-0">
                  <input
                    type="text"
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    placeholder="Filter files…"
                    aria-label="Filter repository files"
                    className="w-full h-7 px-2.5 text-[12px] rounded-[6px] bg-[#F8F9FA] border border-[#E0E2E5] focus:bg-[#FFFFFF] focus:border-[#0D99FF] text-[#121417] placeholder:text-[#6B7078] focus:outline-none"
                  />
                </div>

                <div className="flex-1 overflow-y-auto p-1.5">
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
                    <div className="p-3 text-xs text-[#6B7078]">
                      {isImporting ? 'Reading repository tree…' : 'No matching files.'}
                    </div>
                  )}
                </div>
              </>
            )}

            {sidebarMode === 'search' && (
              <>
                <div className="h-[36px] px-3 bg-[#F8F9FA] flex items-center justify-between border-b border-[#E0E2E5] shrink-0">
                  <span className="text-[11.5px] font-semibold text-[#121417]">Search</span>
                  <span className="text-[11px] font-mono text-[#6B7078] tabular-nums">
                    {searchMatches.length} hits
                  </span>
                </div>
                <div className="p-2 border-b border-[#E0E2E5] shrink-0">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search across repository…"
                    aria-label="Search text across workspace files"
                    className="w-full h-7 px-2.5 text-[12px] rounded-[6px] bg-[#F8F9FA] border border-[#E0E2E5] focus:bg-[#FFFFFF] focus:border-[#0D99FF] text-[#121417] placeholder:text-[#6B7078] focus:outline-none"
                  />
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-[#E0E2E5]">
                  {!searchQuery.trim() ? (
                    <div className="p-3 text-xs text-[#6B7078]">
                      Type any symbol, function, or string to grep across all files in the workspace.
                    </div>
                  ) : searchMatches.length === 0 ? (
                    <div className="p-3 text-xs text-[#6B7078]">No results found.</div>
                  ) : (
                    searchMatches.map((m, idx) => (
                      <button
                        key={`${m.filePath}-${m.line}-${idx}`}
                        type="button"
                        onClick={() => onSelectFile(m.filePath, focusedPane)}
                        className="w-full p-2.5 text-left hover:bg-[#F8F9FA] space-y-0.5 transition-colors"
                      >
                        <div className="flex items-center justify-between text-[11px] font-mono text-[#0D99FF]">
                          <span className="truncate">{m.filePath}</span>
                          <span className="text-[#6B7078] shrink-0">:{m.line}</span>
                        </div>
                        <div className="text-[11px] font-mono text-[#30343A] truncate">
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
                <div className="h-[36px] px-3 bg-[#F8F9FA] flex items-center justify-between border-b border-[#E0E2E5] shrink-0">
                  <span className="text-[11.5px] font-semibold text-[#121417]">
                    Source Control ({changedFilesCount})
                  </span>
                  {debugResult?.gitDiff && (
                    <button
                      type="button"
                      onClick={onResetGit}
                      className="text-[11px] text-[#6B7078] hover:text-[#121417] inline-flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      Discard
                    </button>
                  )}
                </div>

                <div className="p-2.5 border-b border-[#E0E2E5] flex flex-wrap gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={!debugResult?.gitDiff}
                    onClick={() => {
                      setBottomOpen(true);
                      setBottomTab('diff');
                    }}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-[6px] bg-[#121417] hover:bg-[#30343A] text-white disabled:opacity-40 transition-colors"
                  >
                    Open Diff
                  </button>
                  <button
                    type="button"
                    disabled={!debugResult?.gitDiff}
                    onClick={handleDownloadPatch}
                    className="px-2 py-1 text-[11px] rounded-[6px] bg-[#FFFFFF] hover:bg-[#F8F9FA] border border-[#E0E2E5] text-[#30343A] disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" aria-hidden="true" />
                    .patch
                  </button>
                  <button
                    type="button"
                    disabled={diagnostics.length === 0}
                    onClick={handleDownloadSarif}
                    className="px-2 py-1 text-[11px] rounded-[6px] bg-[#FFFFFF] hover:bg-[#F8F9FA] border border-[#E0E2E5] text-[#30343A] disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" aria-hidden="true" />
                    SARIF
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto py-1">
                  {changedFilesCount === 0 ? (
                    <div className="p-3 text-xs text-[#6B7078]">
                      Working tree clean. Run Auto-Fix or give all 20 cursors a task to inspect tracked git changes.
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
                        className="w-full px-3 py-1.5 text-left text-[11.5px] font-mono flex items-center justify-between hover:bg-[#F8F9FA]"
                      >
                        <span
                          className={`truncate ${
                            st === 'A' ? 'text-[#14AE5C]' : 'text-[#D97706]'
                          }`}
                        >
                          {fp}
                        </span>
                        <span
                          className={`font-bold ${
                            st === 'A' ? 'text-[#14AE5C]' : 'text-[#D97706]'
                          }`}
                        >
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
                <div className="h-[36px] px-3 bg-[#F8F9FA] flex items-center justify-between border-b border-[#E0E2E5] shrink-0">
                  <span className="text-[11.5px] font-semibold text-[#121417]">
                    Problems ({openErrorCount + openWarningCount})
                  </span>
                  {diagnostics.some((d) => !d.fixed && d.suggestedLinePatch) && (
                    <button
                      type="button"
                      disabled={isApplying || isSwarmFixing}
                      onClick={onApplyAllFixes}
                      className="text-[11px] font-medium text-[#0D99FF] hover:underline disabled:opacity-50"
                    >
                      Fix All
                    </button>
                  )}
                </div>

                <div className="px-2 py-1.5 border-b border-[#E0E2E5] flex items-center gap-1 overflow-x-auto shrink-0">
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
                      className={`px-2 py-0.5 text-[11px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
                        sourceFilter === flt.id
                          ? 'bg-[#E6F4FF] text-[#0D99FF]'
                          : 'text-[#6B7078] hover:bg-[#F1F3F5] hover:text-[#121417]'
                      }`}
                    >
                      {flt.label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto divide-y divide-[#E0E2E5]">
                  {filteredDiagnostics.length === 0 ? (
                    <div className="p-3 text-xs text-[#6B7078]">
                      0 matching diagnostics in repository.
                    </div>
                  ) : (
                    filteredDiagnostics.map((diag) => (
                      <div key={diag.id} className="p-2.5 space-y-1 hover:bg-[#F8F9FA]">
                        <button
                          type="button"
                          onClick={() => handleJumpToDiagnostic(diag)}
                          className="w-full text-left space-y-0.5"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                            <span
                              className={
                                diag.fixed
                                  ? 'text-[#14AE5C]'
                                  : diag.severity === 'error'
                                  ? 'text-[#F24822]'
                                  : 'text-[#D97706]'
                              }
                            >
                              {diag.code}
                            </span>
                            <span className="text-[#6B7078] truncate">
                              {diag.filePath}:{diag.line}
                            </span>
                          </div>
                          <p className="text-[12px] text-[#121417] leading-snug">{diag.title}</p>
                        </button>
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-[#6B7078] font-mono">
                            {diag.fixed ? 'Verified fixed' : diag.source}
                          </span>
                          {!diag.fixed && (diag.suggestedLinePatch || diag.suggestedFilePatch) && (
                            <button
                              type="button"
                              disabled={isApplying || isSwarmFixing}
                              onClick={() => onApplySingleFix(diag.id)}
                              className="px-2 py-0.5 bg-[#E6F4FF] hover:bg-[#0D99FF] text-[#0D99FF] hover:text-white rounded-[4px] text-[10.5px] font-medium transition-colors"
                            >
                              Apply Fix
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </aside>
        )}

        {/* Center Workbench: Split Editors + Bottom Panel */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#FFFFFF]">
          {errorMsg && (
            <div
              role="alert"
              className="px-3 py-1.5 bg-[#FEF2F2] border-b border-[#F24822]/30 text-xs text-[#F24822] shrink-0"
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

          {/* Integrated Bottom Panel */}
          <section className="border-t border-[#E0E2E5] bg-[#FFFFFF] flex flex-col shrink-0">
            <div className="h-[34px] px-3 bg-[#F8F9FA] flex items-center justify-between border-b border-[#E0E2E5]">
              <div className="flex items-center gap-5 text-[11.5px] font-medium">
                <button
                  type="button"
                  onClick={() => {
                    setBottomOpen(true);
                    setBottomTab('problems');
                  }}
                  className={`py-1.5 border-b-2 transition-colors ${
                    bottomOpen && bottomTab === 'problems'
                      ? 'border-[#0D99FF] text-[#121417]'
                      : 'border-transparent text-[#6B7078] hover:text-[#121417]'
                  }`}
                >
                  Problems ({openErrorCount + openWarningCount})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBottomOpen(true);
                    setBottomTab('output');
                  }}
                  className={`py-1.5 border-b-2 transition-colors ${
                    bottomOpen && bottomTab === 'output'
                      ? 'border-[#0D99FF] text-[#121417]'
                      : 'border-transparent text-[#6B7078] hover:text-[#121417]'
                  }`}
                >
                  Output ({agentOutputLogs.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBottomOpen(true);
                    setBottomTab('terminal');
                  }}
                  className={`py-1.5 border-b-2 transition-colors ${
                    bottomOpen && bottomTab === 'terminal'
                      ? 'border-[#0D99FF] text-[#121417]'
                      : 'border-transparent text-[#6B7078] hover:text-[#121417]'
                  }`}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBottomOpen(true);
                    setBottomTab('diff');
                  }}
                  className={`py-1.5 border-b-2 transition-colors ${
                    bottomOpen && bottomTab === 'diff'
                      ? 'border-[#0D99FF] text-[#121417]'
                      : 'border-transparent text-[#6B7078] hover:text-[#121417]'
                  }`}
                >
                  Git Diff ({changedFilesCount})
                </button>
              </div>

              <button
                type="button"
                onClick={() => setBottomOpen((p) => !p)}
                className="text-[11px] font-medium text-[#6B7078] hover:text-[#121417]"
              >
                {bottomOpen ? 'Hide' : 'Show'}
              </button>
            </div>

            {bottomOpen && (
              <div className="h-[180px] overflow-y-auto bg-[#FFFFFF] font-mono text-[11.5px]">
                {bottomTab === 'problems' && (
                  <div className="divide-y divide-[#E0E2E5]">
                    {diagnostics.length === 0 ? (
                      <div className="p-3 text-[#6B7078]">
                        No problems detected in workspace.
                      </div>
                    ) : (
                      diagnostics.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => handleJumpToDiagnostic(d)}
                          className="w-full px-3 py-1.5 text-left hover:bg-[#F8F9FA] flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {d.fixed ? (
                              <Check className="w-3.5 h-3.5 text-[#14AE5C] shrink-0" aria-hidden="true" />
                            ) : d.severity === 'error' ? (
                              <AlertCircle className="w-3.5 h-3.5 text-[#F24822] shrink-0" aria-hidden="true" />
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5 text-[#D97706] shrink-0" aria-hidden="true" />
                            )}
                            <span
                              className={`truncate ${
                                d.fixed ? 'text-[#6B7078] line-through' : 'text-[#121417]'
                              }`}
                            >
                              {d.title} — {d.message}
                            </span>
                            <span className="text-[#6B7078] shrink-0">[{d.code}]</span>
                          </div>
                          <span className="text-[#6B7078] shrink-0">
                            {d.filePath}:{d.line}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {bottomTab === 'output' && (
                  <div className="p-3 space-y-1">
                    {agentOutputLogs.map((line, i) => (
                      <div
                        key={`${i}-${line.slice(0, 12)}`}
                        className={
                          line.includes('Wrote') || line.includes('Created') || line.includes('Done')
                            ? 'text-[#14AE5C]'
                            : line.includes('ROLLBACK') || line.includes('FAILED')
                            ? 'text-[#F24822]'
                            : line.startsWith('$')
                            ? 'text-[#0D99FF] font-medium'
                            : 'text-[#30343A]'
                        }
                      >
                        {line}
                      </div>
                    ))}
                    <div ref={outputEndRef} />
                  </div>
                )}

                {bottomTab === 'terminal' && (
                  <div className="h-full flex flex-col">
                    <div className="px-3 py-1.5 border-b border-[#E0E2E5] bg-[#F8F9FA] flex items-center justify-between gap-2 shrink-0">
                      <div className="flex items-center gap-2 text-[11px]">
                        <Terminal className="w-3.5 h-3.5 text-[#0D99FF]" aria-hidden="true" />
                        <span className="text-[#30343A]">bash · {workspace?.repoName ?? 'workspace'}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {(['tsc --noEmit', 'tsx --test', 'git status'] as const).map((presetCmd) => (
                          <button
                            key={presetCmd}
                            type="button"
                            disabled={!workspace || isRunningCommand}
                            onClick={() => onRunTerminalCommand(presetCmd)}
                            className="px-2 py-0.5 text-[10.5px] rounded-[4px] bg-[#FFFFFF] hover:bg-[#E6F4FF] border border-[#E0E2E5] text-[#30343A] hover:text-[#0D99FF] disabled:opacity-45 transition-colors"
                          >
                            {presetCmd}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                      {debugResult && (
                        <div className="space-y-1 text-[#6B7078]">
                          <div className={debugResult.tscResult.errorCount === 0 ? 'text-[#14AE5C]' : 'text-[#F24822]'}>
                            [tsc --noEmit] {debugResult.tscResult.output}
                          </div>
                          {debugResult.testResult.ran && (
                            <div className={debugResult.testResult.failed === 0 ? 'text-[#14AE5C]' : 'text-[#F24822]'}>
                              [{debugResult.testResult.command}] passed={debugResult.testResult.passed}, failed={debugResult.testResult.failed}
                            </div>
                          )}
                        </div>
                      )}

                      {terminalHistory.map((item, idx) => (
                        <div key={idx} className="space-y-0.5">
                          <div className="text-[#0D99FF] font-medium">$ {item.command}</div>
                          <pre
                            className={`whitespace-pre-wrap break-words ${
                              item.exitCode === 0 ? 'text-[#121417]' : 'text-[#F24822]'
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
                      className="px-3 py-1.5 border-t border-[#E0E2E5] bg-[#F8F9FA] flex items-center gap-2 shrink-0"
                    >
                      <span className="text-[#0D99FF] font-semibold">$</span>
                      <input
                        type="text"
                        value={terminalCmdInput}
                        onChange={(e) => setTerminalCmdInput(e.target.value)}
                        placeholder="Run tsc --noEmit, tsx --test, git status, git diff, ls, or help…"
                        aria-label="Workspace terminal command"
                        className="flex-1 bg-transparent text-[#121417] placeholder:text-[#6B7078] focus:outline-none text-[11.5px]"
                      />
                    </form>
                  </div>
                )}

                {bottomTab === 'diff' && (
                  <div className="p-3 space-y-2">
                    <div className="flex items-center justify-between border-b border-[#E0E2E5] pb-1.5">
                      <span className="text-[#6B7078]">
                        git diff --no-color ({changedFilesCount} changed file{changedFilesCount === 1 ? '' : 's'})
                      </span>
                      <button
                        type="button"
                        disabled={!debugResult?.gitDiff}
                        onClick={handleCopyDiff}
                        className="px-2 py-0.5 text-[10.5px] rounded-[4px] bg-[#FFFFFF] hover:bg-[#F8F9FA] border border-[#E0E2E5] text-[#30343A] inline-flex items-center gap-1 disabled:opacity-40"
                      >
                        {copiedDiff ? <Check className="w-3 h-3 text-[#14AE5C]" /> : <Copy className="w-3 h-3" />}
                        {copiedDiff ? 'Copied' : 'Copy Diff'}
                      </button>
                    </div>
                    {!debugResult?.gitDiff ? (
                      <div className="text-[#6B7078]">Working tree clean — no diff yet.</div>
                    ) : (
                      <pre className="space-y-0.5">
                        {debugResult.gitDiff.split('\n').map((l, idx) => {
                          let cls = 'text-[#30343A]';
                          if (l.startsWith('+') && !l.startsWith('+++')) cls = 'bg-[#ECFDF5] text-[#14AE5C]';
                          else if (l.startsWith('-') && !l.startsWith('---')) cls = 'bg-[#FEF2F2] text-[#F24822]';
                          else if (l.startsWith('@@')) cls = 'text-[#0D99FF]';
                          else if (l.startsWith('diff --git')) cls = 'text-[#121417] font-semibold';
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

        {/* Right Auxiliary Sidebar: Swarm Task Panel */}
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

      {/* Bottom Status Bar */}
      <footer className="h-[24px] bg-[#F8F9FA] border-t border-[#E0E2E5] pr-3 flex items-center justify-between text-[11px] font-mono text-[#30343A] shrink-0">
        <div className="flex items-center gap-3 h-full">
          <div className="h-full px-2.5 bg-[#121417] text-white font-semibold flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0D99FF]" />
            <span>Swarm · {agentCount} Cursors</span>
          </div>
          <span className="flex items-center gap-1 text-[#30343A]">
            <GitBranch className="w-3 h-3 text-[#6B7078]" aria-hidden="true" />
            <span>{workspace?.branch ?? 'main'}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setBottomOpen(true);
              setBottomTab('problems');
            }}
            className="flex items-center gap-2 hover:text-[#121417]"
          >
            <span className={openErrorCount > 0 ? 'text-[#F24822]' : 'text-[#6B7078]'}>
              ⊗ {openErrorCount}
            </span>
            <span className={openWarningCount > 0 ? 'text-[#D97706]' : 'text-[#6B7078]'}>
              ⚠ {openWarningCount}
            </span>
          </button>
          {fixedCount > 0 && (
            <span className="text-[#14AE5C] hidden sm:inline">✓ {fixedCount} fixed</span>
          )}
          {activeFixingAgents > 0 ? (
            <span className="text-[#0D99FF] font-medium">
              ● All {activeFixingAgents} cursors converged on {focusedFilePath || 'workspace'}
            </span>
          ) : (
            <span className="text-[#6B7078] hidden md:inline">
              ● {cursorAgents.length} cursors roaming
            </span>
          )}
        </div>

        <div className="flex items-center gap-4 text-[#6B7078]">
          {debugResult && (
            <span className="hidden md:inline">
              tsc: {debugResult.tscResult.errorCount} err · tests: {debugResult.testResult.passed} pass / {debugResult.testResult.failed} fail
            </span>
          )}
          <span>
            Ln {focusedCursor?.line ?? 1}, Col {focusedCursor?.column ?? 1}
          </span>
          <span className="hidden sm:inline">UTF-8</span>
          <span className="hidden sm:inline">TypeScript</span>
        </div>
      </footer>

      {/* Live 20-Cursor Animated Pointer Swarm Overlay */}
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
