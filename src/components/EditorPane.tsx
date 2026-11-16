import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  RotateCcw,
  ScanSearch,
  X,
} from 'lucide-react';
import { renderHighlightedLine } from '../utils/vscodeHighlight';
import type {
  CodeDiagnostic,
  CursorAgentState,
  GitFileStatus,
} from '../types/ide';
import { VsCodeFileIcon } from './VsCodeFileIcon';

interface EditorPaneProps {
  paneId: 'primary' | 'secondary';
  isFocused: boolean;
  isSplitActive: boolean;
  tabs: string[];
  activeFilePath: string;
  fileContents: Record<string, string>;
  fileStatuses: Record<string, GitFileStatus>;
  diagnostics: CodeDiagnostic[];
  cursorAgents: CursorAgentState[];
  streamingFiles: Record<string, boolean>;
  selectedDiagId: string | null;
  onFocusPane: () => void;
  onSelectFile: (filePath: string) => void;
  onCloseTab: (filePath: string) => void;
  onSplitRight?: () => void;
  onClosePane?: () => void;
  onSelectDiagnostic: (diag: CodeDiagnostic) => void;
  onApplySingleFix: (diagnosticId: string) => void;
  onSaveManualEdit: (filePath: string, nextContent: string) => void;
  onResetGit?: () => void;
  hasGitDiff?: boolean;
  busy?: boolean;
}

export function EditorPane({
  paneId,
  isFocused,
  isSplitActive,
  tabs,
  activeFilePath,
  fileContents,
  fileStatuses,
  diagnostics,
  cursorAgents,
  streamingFiles,
  selectedDiagId,
  onFocusPane,
  onSelectFile,
  onCloseTab,
  onSplitRight,
  onClosePane,
  onSelectDiagnostic,
  onApplySingleFix,
  onSaveManualEdit,
  onResetGit,
  hasGitDiff = false,
  busy = false,
}: EditorPaneProps) {
  const [isEditingManual, setIsEditingManual] = useState(false);
  const [manualDraft, setManualDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  const activeContent = fileContents[activeFilePath] ?? '';
  const codeLines = useMemo(() => activeContent.split(/\r?\n/), [activeContent]);
  const isStreamingHere = Boolean(streamingFiles[activeFilePath]);

  useEffect(() => {
    setManualDraft(activeContent);
    setIsEditingManual(false);
  }, [activeFilePath]);

  useEffect(() => {
    if (!isEditingManual) {
      setManualDraft(activeContent);
    }
  }, [activeContent, isEditingManual]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeFilePath, tabs.length]);

  const fileDiagnostics = useMemo(
    () => diagnostics.filter((d) => d.filePath === activeFilePath),
    [diagnostics, activeFilePath]
  );

  const cursorsInFile = useMemo(
    () =>
      cursorAgents.filter(
        (a) =>
          a.filePath === activeFilePath &&
          ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(a.status)
      ),
    [cursorAgents, activeFilePath]
  );

  const primaryCursor = cursorsInFile[0] ?? null;

  useEffect(() => {
    const selectedDiag = fileDiagnostics.find((d) => d.id === selectedDiagId);
    const targetLine = primaryCursor?.line ?? selectedDiag?.line ?? null;
    if (!targetLine || !scrollRef.current) return;

    const lineEl = scrollRef.current.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
    if (lineEl) {
      const container = scrollRef.current;
      const top = lineEl.offsetTop;
      const visibleTop = container.scrollTop;
      const visibleBottom = visibleTop + container.clientHeight;
      if (top < visibleTop + 44 || top > visibleBottom - 72) {
        container.scrollTo({
          top: Math.max(0, top - Math.round(container.clientHeight * 0.35)),
          behavior: 'smooth',
        });
      }
    }
  }, [activeFilePath, primaryCursor?.line, selectedDiagId, fileDiagnostics]);

  const breadcrumbs = activeFilePath ? activeFilePath.split('/') : ['Welcome'];

  const handleMinimapClick = (ratio: number) => {
    if (!scrollRef.current) return;
    const maxScroll = Math.max(0, scrollRef.current.scrollHeight - scrollRef.current.clientHeight);
    scrollRef.current.scrollTo({
      top: Math.round(maxScroll * ratio),
      behavior: 'smooth',
    });
  };

  return (
    <section
      data-editor-pane={paneId}
      onClick={onFocusPane}
      aria-label={paneId === 'primary' ? 'Primary Editor Pane' : 'Split Editor Pane'}
      className={`flex-1 flex flex-col min-w-0 min-h-0 bg-[#1e1e1e] ${
        paneId === 'secondary' ? 'border-l border-[#252526]' : ''
      }`}
    >
      {/* Editor Tabs Bar */}
      <div className="h-[35px] bg-[#252526] border-b border-[#1e1e1e] flex items-center justify-between shrink-0">
        <div className="flex items-end overflow-x-auto h-full min-w-0">
          {tabs.map((tabPath) => {
            const isActive = tabPath === activeFilePath;
            const fileName = tabPath.split('/').pop() ?? tabPath;
            const gitStatus = fileStatuses[tabPath];
            const activeTabAgents = cursorAgents.filter(
              (a) =>
                a.filePath === tabPath &&
                ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(a.status)
            );
            const openErrors = diagnostics.filter(
              (d) => d.filePath === tabPath && !d.fixed
            ).length;

            const tabTextColor =
              gitStatus === 'A'
                ? 'text-[#81b88b]'
                : gitStatus === 'M'
                ? 'text-[#e2c08d]'
                : openErrors > 0 && !isActive
                ? 'text-[#f48771]'
                : isActive
                ? 'text-[#ffffff]'
                : 'text-[#969696]';

            return (
              <div
                key={tabPath}
                ref={isActive ? activeTabRef : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onFocusPane();
                  onSelectFile(tabPath);
                }}
                className={`group h-[35px] flex items-center gap-1.5 pl-2.5 pr-2 border-r border-[#252526] text-[13px] cursor-pointer shrink-0 transition-colors ${
                  isActive
                    ? `bg-[#1e1e1e] ${isFocused ? 'border-t border-t-[#007acc]' : 'border-t border-t-transparent'}`
                    : 'bg-[#2d2d2d] hover:bg-[#2a2d2e] border-t border-t-transparent'
                }`}
              >
                <VsCodeFileIcon filePath={tabPath} className="w-[16px] h-[16px]" />
                <span className={`max-w-[150px] truncate ${tabTextColor}`}>{fileName}</span>

                {activeTabAgents.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-1 py-0 rounded bg-[#094771] text-[#ffffff] text-[10px] font-semibold tabular-nums"
                    title={`${activeTabAgents.length} cursor(s) working in this file`}
                  >
                    <span className="flex -space-x-0.5">
                      {activeTabAgents.slice(0, 3).map((a) => (
                        <span key={a.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: a.color }} />
                      ))}
                    </span>
                    {activeTabAgents.length}
                  </span>
                )}

                {gitStatus && activeTabAgents.length === 0 && (
                  <span
                    className={`text-[11px] font-semibold ${
                      gitStatus === 'A' ? 'text-[#81b88b]' : 'text-[#e2c08d]'
                    }`}
                  >
                    {gitStatus}
                  </span>
                )}

                {openErrors > 0 && (
                  <span className="text-[11px] text-[#f14c4c] font-semibold tabular-nums">
                    {openErrors}
                  </span>
                )}

                <button
                  type="button"
                  aria-label={`Close ${fileName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tabPath);
                  }}
                  className={`ml-0.5 p-0.5 rounded hover:bg-[#ffffff]/10 text-[#969696] hover:text-[#ffffff] ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                >
                  <X className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Editor Group Actions */}
        <div className="flex items-center gap-0.5 px-2 shrink-0">
          {activeFilePath && !isEditingManual && (
            <button
              type="button"
              onClick={() => setIsEditingManual(true)}
              className="h-6 px-2 text-[12px] rounded text-[#cccccc] hover:bg-[#ffffff]/10 transition-colors"
              title="Edit File Manually"
            >
              Edit
            </button>
          )}
          {isEditingManual && (
            <>
              <button
                type="button"
                onClick={() => {
                  onSaveManualEdit(activeFilePath, manualDraft);
                  setIsEditingManual(false);
                }}
                className="h-6 px-2 text-[12px] rounded bg-[#007acc] hover:bg-[#1f8ad2] text-white transition-colors"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualDraft(activeContent);
                  setIsEditingManual(false);
                }}
                className="h-6 px-2 text-[12px] rounded bg-[#3c3c3c] text-[#cccccc] hover:bg-[#4c4c4c]"
              >
                Cancel
              </button>
            </>
          )}
          {hasGitDiff && paneId === 'primary' && onResetGit && (
            <button
              type="button"
              disabled={busy}
              onClick={onResetGit}
              title="Reset Workspace"
              className="h-6 w-6 text-[#cccccc] hover:bg-[#ffffff]/10 rounded inline-flex items-center justify-center disabled:opacity-40"
            >
              <RotateCcw className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {paneId === 'primary' && onSplitRight && (
            <button
              type="button"
              onClick={onSplitRight}
              aria-label={isSplitActive ? 'Close Split Editor' : 'Split Editor Right'}
              title={isSplitActive ? 'Close Split Editor' : 'Split Editor Right'}
              className={`h-6 w-6 rounded inline-flex items-center justify-center transition-colors ${
                isSplitActive
                  ? 'bg-[#094771] text-[#ffffff]'
                  : 'text-[#cccccc] hover:bg-[#ffffff]/10'
              }`}
            >
              <Columns2 className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          {paneId === 'secondary' && onClosePane && (
            <button
              type="button"
              onClick={onClosePane}
              aria-label="Close Split Pane"
              title="Close Split Pane"
              className="h-6 w-6 rounded text-[#cccccc] hover:bg-[#ffffff]/10 inline-flex items-center justify-center"
            >
              <X className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumbs Bar */}
      <div className="h-[22px] px-3 bg-[#1e1e1e] flex items-center justify-between gap-3 text-[12px] text-[#969696] shrink-0 border-b border-[#1e1e1e]">
        <div className="flex items-center gap-0.5 min-w-0 truncate">
          {breadcrumbs.map((seg, i) => (
            <span key={`${seg}-${i}`} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-[#6a6a6a] shrink-0" strokeWidth={1.5} aria-hidden="true" />}
              <span className={i === breadcrumbs.length - 1 ? 'text-[#cccccc]' : 'hover:text-[#cccccc] cursor-pointer'}>
                {seg}
              </span>
            </span>
          ))}
        </div>

        <span className="inline-flex items-center gap-2 text-[11px] truncate shrink-0">
          {isStreamingHere && (
            <span className="inline-flex items-center gap-1 text-[#3794ff]">
              <ScanSearch className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
              streaming
            </span>
          )}
          {cursorsInFile.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[#cccccc]">
              <span className="flex -space-x-1">
                {cursorsInFile.slice(0, 4).map((agent) => (
                  <span
                    key={agent.id}
                    className="w-2 h-2 rounded-full ring-1 ring-[#1e1e1e]"
                    style={{ backgroundColor: agent.color }}
                    title={`${agent.status} · Ln ${agent.line}, Col ${agent.column}`}
                  />
                ))}
              </span>
              <span className="text-[#969696]">
                {cursorsInFile.length} cursor{cursorsInFile.length === 1 ? '' : 's'} ·{' '}
                {primaryCursor ? `Ln ${primaryCursor.line}, Col ${primaryCursor.column}` : ''}
              </span>
            </span>
          ) : (
            <span className="text-[#6a6a6a]"> </span>
          )}
        </span>
      </div>

      {/* Code Viewport + Minimap */}
      {!activeFilePath ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-[#1e1e1e] text-[#969696]">
          <p className="text-sm font-medium text-[#cccccc]">No editor is open</p>
          <p className="text-xs mt-1 max-w-sm text-[#858585]">
            Select a file from the explorer, or import a repo and run a scan.
          </p>
        </div>
      ) : isEditingManual ? (
        <textarea
          aria-label={`Edit ${activeFilePath}`}
          value={manualDraft}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setManualDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[13px] leading-[20px] p-4 focus:outline-none resize-none"
        />
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden bg-[#1e1e1e]">
          <div
            ref={scrollRef}
            className="flex-1 overflow-auto py-1 font-mono text-[13px] leading-[20px] select-text"
          >
            <div className="min-w-max">
              {codeLines.map((lineText, idx) => {
                const lineNum = idx + 1;
                const lineDiags = fileDiagnostics.filter((d) => d.line === lineNum);
                const openDiag = lineDiags.find((d) => !d.fixed);
                const fixedDiag = lineDiags.find((d) => d.fixed);
                const lineCursors = cursorsInFile.filter((c) => c.line === lineNum);
                const isSelectedDiag = lineDiags.some((d) => d.id === selectedDiagId);
                const isWritingHere =
                  isStreamingHere &&
                  (lineCursors.length > 0 || lineNum === codeLines.length);

                const indentMatch = lineText.match(/^(\s+)/);
                const indentDepth = indentMatch ? Math.floor(indentMatch[1].length / 2) : 0;
                const hasFold = /\{\s*$/.test(lineText);

                let rowBg = '';
                if (isWritingHere || lineCursors.some((c) => c.status === 'writing' || c.status === 'editing')) {
                  rowBg = 'bg-[#264f78]/30';
                } else if (lineCursors.length > 0) {
                  rowBg = 'bg-[#2a2d2e]/60';
                } else if (isSelectedDiag) {
                  rowBg = 'bg-[#264f78]/40';
                } else if (openDiag) {
                  rowBg = openDiag.severity === 'error' ? 'bg-[#5a1d1d]/40' : 'bg-[#4d3800]/30';
                } else if (fixedDiag) {
                  rowBg = 'bg-[#1e3a1e]/30';
                }

                const primaryLineCursor = lineCursors[0];

                return (
                  <div
                    key={lineNum}
                    data-line={lineNum}
                    onClick={() => {
                      if (lineDiags[0]) onSelectDiagnostic(lineDiags[0]);
                    }}
                    className={`group flex items-start pr-4 relative ${rowBg}`}
                  >
                    {/* Gutter */}
                    <span className="w-[60px] pr-3 text-right text-[#858585] select-none shrink-0 flex items-center justify-end gap-1.5">
                      {primaryLineCursor ? (
                        <span
                          className="w-1.5 h-3.5 rounded-[1px]"
                          style={{ backgroundColor: primaryLineCursor.color }}
                        />
                      ) : openDiag ? (
                        <span
                          className={`w-2 h-2 rounded-full ${
                            openDiag.severity === 'error' ? 'bg-[#f14c4c]' : 'bg-[#cca700]'
                          }`}
                        />
                      ) : fixedDiag ? (
                        <span className="w-2 h-2 rounded-full bg-[#89d185]" />
                      ) : null}
                      <span className="text-[13px] leading-[20px] tabular-nums">{lineNum}</span>
                      <span className="w-3 inline-flex justify-center opacity-0 group-hover:opacity-70 text-[#c5c5c5]">
                        {hasFold && <ChevronDown className="w-3 h-3" strokeWidth={1.5} aria-hidden="true" />}
                      </span>
                    </span>

                    {/* Code Line */}
                    <div className="flex-1 min-w-0 relative whitespace-pre pl-1">
                      {indentDepth > 0 &&
                        Array.from({ length: Math.min(indentDepth, 8) }).map((_, gIdx) => (
                          <span
                            key={gIdx}
                            aria-hidden="true"
                            style={{ left: `${gIdx * 2 + 0.25}ch` }}
                            className="absolute top-0 bottom-0 w-px bg-[#404040] pointer-events-none"
                          />
                        ))}

                      <span
                        className={
                          openDiag
                            ? `underline decoration-wavy ${
                                openDiag.severity === 'error'
                                  ? 'decoration-[#f14c4c]'
                                  : 'decoration-[#cca700]'
                              } underline-offset-2`
                            : ''
                        }
                      >
                        {renderHighlightedLine(lineText)}
                      </span>

                      {lineCursors.slice(0, 4).map((agent) => {
                        const agentCaretCol = Math.max(
                          0,
                          Math.min(lineText.length, agent.column - 1)
                        );
                        return (
                          <span
                            key={agent.id}
                            style={{ left: `${agentCaretCol + 0.25}ch` }}
                            className="absolute top-0 pointer-events-none z-10 transition-[left] duration-300 ease-out"
                          >
                            <span
                              className="swarm-caret"
                              style={{ backgroundColor: agent.color }}
                            />
                          </span>
                        );
                      })}
                    </div>

                    {/* Inline diagnostic annotation */}
                    {openDiag && lineCursors.length === 0 && (
                      <span className="ml-6 inline-flex items-center gap-2 shrink-0 text-[12px] font-sans max-w-[420px]">
                        <span
                          className={`truncate ${
                            openDiag.severity === 'error' ? 'text-[#f48771]' : 'text-[#cca700]'
                          }`}
                          title={openDiag.message}
                        >
                          [{openDiag.source}] {openDiag.severity} · {openDiag.code}
                        </span>
                        {(openDiag.suggestedLinePatch || openDiag.suggestedFilePatch) && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onApplySingleFix(openDiag.id);
                            }}
                            className="px-2 py-0.5 rounded bg-[#094771] hover:bg-[#0e639c] text-[#ffffff] text-[11px] shrink-0 transition-colors"
                            title="Apply suggested repair"
                          >
                            Quick Fix
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Minimap */}
          <div
            aria-label="Editor Minimap"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
              handleMinimapClick(ratio);
            }}
            className="w-[60px] bg-[#1e1e1e] border-l border-[#2b2b2b] py-1 px-1.5 shrink-0 cursor-pointer overflow-hidden relative select-none"
            title="Minimap"
          >
            <div className="space-y-[2px] opacity-60">
              {codeLines.slice(0, 180).map((lineText, idx) => {
                const lineNum = idx + 1;
                const trimmed = lineText.trim();
                const hasError = fileDiagnostics.some((d) => d.line === lineNum && !d.fixed);
                const hasCursor = cursorsInFile.some((c) => c.line === lineNum);
                const activeCursor = cursorsInFile.find((c) => c.line === lineNum);
                const widthPct = trimmed.length === 0 ? 0 : Math.min(100, Math.max(15, Math.round((trimmed.length / 72) * 100)));

                let barColor = 'bg-[#5a5a5a]';
                if (hasCursor && activeCursor) {
                  barColor = '';
                } else if (hasError) {
                  barColor = 'bg-[#f14c4c]';
                } else if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                  barColor = 'bg-[#6a9955]';
                } else if (trimmed.startsWith('export') || trimmed.startsWith('import')) {
                  barColor = 'bg-[#c586c0]';
                }

                return (
                  <div key={lineNum} className="h-[2px] flex items-center">
                    {widthPct > 0 && (
                      <div
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: hasCursor && activeCursor ? activeCursor.color : undefined,
                        }}
                        className={`h-full ${barColor}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
