import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  MousePointer2,
  RotateCcw,
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
  }, [activeFilePath, activeContent]);

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
      className={`flex-1 flex flex-col min-w-0 min-h-0 bg-[#FFFFFF] ${
        paneId === 'secondary' ? 'border-l border-[#E0E2E5]' : ''
      }`}
    >
      {/* Editor Tabs Bar */}
      <div className="h-[36px] bg-[#F8F9FA] border-b border-[#E0E2E5] flex items-center justify-between shrink-0">
        <div className="flex items-center overflow-x-auto h-full min-w-0">
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
                ? 'text-[#14AE5C]'
                : gitStatus === 'M'
                ? 'text-[#D97706]'
                : openErrors > 0 && !isActive
                ? 'text-[#F24822]'
                : isActive
                ? 'text-[#121417] font-medium'
                : 'text-[#6B7078]';

            return (
              <div
                key={tabPath}
                ref={isActive ? activeTabRef : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onFocusPane();
                  onSelectFile(tabPath);
                }}
                className={`group h-full flex items-center gap-2 px-3 border-r border-[#E0E2E5] text-[12px] font-mono cursor-pointer shrink-0 transition-colors ${
                  isActive
                    ? `bg-[#FFFFFF] border-t-2 ${
                        isFocused ? 'border-t-[#0D99FF]' : 'border-t-[#9DA2A9]'
                      }`
                    : 'bg-[#F8F9FA] hover:bg-[#FFFFFF]/70 border-t-2 border-t-transparent'
                }`}
              >
                <VsCodeFileIcon filePath={tabPath} />
                <span className={tabTextColor}>{fileName}</span>

                {activeTabAgents.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded-[4px] bg-[#E6F4FF] text-[#0D99FF] text-[9.5px] font-semibold tabular-nums">
                    {activeTabAgents.length}
                  </span>
                )}

                {gitStatus && activeTabAgents.length === 0 && (
                  <span
                    className={`text-[10px] font-bold ${
                      gitStatus === 'A' ? 'text-[#14AE5C]' : 'text-[#D97706]'
                    }`}
                  >
                    {gitStatus}
                  </span>
                )}

                {openErrors > 0 && (
                  <span className="text-[10px] text-[#F24822] font-semibold tabular-nums">
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
                  className="p-0.5 rounded-[4px] hover:bg-[#E0E2E5] text-[#6B7078] hover:text-[#121417] opacity-70 group-hover:opacity-100"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Editor Group Actions */}
        <div className="flex items-center gap-1 px-2 shrink-0">
          {activeFilePath && !isEditingManual && (
            <button
              type="button"
              onClick={() => setIsEditingManual(true)}
              className="h-6 px-2.5 text-[11px] font-medium rounded-[6px] text-[#30343A] hover:bg-[#E0E2E5]/60 transition-colors"
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
                className="h-6 px-2.5 text-[11px] font-medium rounded-[6px] bg-[#0D99FF] hover:bg-[#0080E6] text-white transition-colors"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualDraft(activeContent);
                  setIsEditingManual(false);
                }}
                className="h-6 px-2.5 text-[11px] font-medium rounded-[6px] bg-[#FFFFFF] border border-[#E0E2E5] text-[#30343A] hover:bg-[#F8F9FA]"
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
              title="Reset Workspace to Clean Git Baseline"
              className="h-6 px-1.5 text-[11px] rounded-[6px] text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60 inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {paneId === 'primary' && onSplitRight && (
            <button
              type="button"
              onClick={onSplitRight}
              aria-label={isSplitActive ? 'Close Split Editor' : 'Split Editor Right'}
              title={isSplitActive ? 'Close Split Editor' : 'Split Editor Right'}
              className={`h-6 w-6 rounded-[6px] inline-flex items-center justify-center transition-colors ${
                isSplitActive
                  ? 'bg-[#E6F4FF] text-[#0D99FF]'
                  : 'text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60'
              }`}
            >
              <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          {paneId === 'secondary' && onClosePane && (
            <button
              type="button"
              onClick={onClosePane}
              aria-label="Close Split Pane"
              title="Close Split Pane"
              className="h-6 w-6 rounded-[6px] text-[#6B7078] hover:text-[#121417] hover:bg-[#E0E2E5]/60 inline-flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumbs Bar */}
      <div className="h-[24px] px-3 bg-[#FFFFFF] border-b border-[#E0E2E5] flex items-center justify-between gap-3 text-[11px] font-mono text-[#6B7078] shrink-0">
        <div className="flex items-center gap-1 min-w-0 truncate">
          {breadcrumbs.map((seg, i) => (
            <span key={`${seg}-${i}`} className="flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 text-[#9DA2A9] shrink-0" aria-hidden="true" />}
              <span className={i === breadcrumbs.length - 1 ? 'text-[#121417] font-medium' : ''}>
                {seg}
              </span>
            </span>
          ))}
        </div>

        {primaryCursor && (
          <span
            className="inline-flex items-center gap-1.5 text-[10.5px] font-medium truncate shrink-0"
            style={{ color: primaryCursor.color }}
          >
            <MousePointer2 className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>
              {primaryCursor.name} · Ln {primaryCursor.line}, Col {primaryCursor.column}
              {cursorsInFile.length > 1 ? ` (+${cursorsInFile.length - 1} in file)` : ''}
            </span>
          </span>
        )}
      </div>

      {/* Code Viewport + Proportional Minimap */}
      {!activeFilePath ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-[#FFFFFF] text-[#6B7078]">
          <p className="text-sm font-semibold text-[#121417]">Swarm Code Workbench</p>
          <p className="text-xs mt-1 max-w-sm">
            Select a file from Explorer, click Auto-Fix, or give all 20 cursors a task in the right panel.
          </p>
        </div>
      ) : isEditingManual ? (
        <textarea
          aria-label={`Edit ${activeFilePath}`}
          value={manualDraft}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setManualDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full bg-[#FFFFFF] text-[#121417] font-mono text-[12.5px] leading-[20px] p-4 focus:outline-none resize-none"
        />
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden bg-[#FFFFFF]">
          <div
            ref={scrollRef}
            className="flex-1 overflow-auto py-2 font-mono text-[12.5px] leading-[20px] select-text"
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
                  rowBg = 'bg-[#0D99FF]/[0.08]';
                } else if (lineCursors.length > 0) {
                  rowBg = 'bg-[#F8F9FA]';
                } else if (isSelectedDiag) {
                  rowBg = 'bg-[#0D99FF]/[0.11]';
                } else if (openDiag) {
                  rowBg =
                    openDiag.severity === 'error'
                      ? 'bg-[#FEF2F2]'
                      : 'bg-[#FFFBEB]';
                } else if (fixedDiag) {
                  rowBg = 'bg-[#ECFDF5]';
                }

                const primaryLineCursor = lineCursors[0];

                return (
                  <div
                    key={lineNum}
                    data-line={lineNum}
                    onClick={() => {
                      if (lineDiags[0]) onSelectDiagnostic(lineDiags[0]);
                    }}
                    className={`group flex items-start pr-4 relative transition-colors ${rowBg}`}
                  >
                    {/* Gutter: Line Number + Fold Indicator + Diagnostic Dot */}
                    <span className="w-[46px] pr-1.5 text-right text-[#8F949B] select-none shrink-0 flex items-center justify-end gap-1">
                      {primaryLineCursor ? (
                        <span
                          className="w-1.5 h-3.5 rounded-[1px]"
                          style={{ backgroundColor: primaryLineCursor.color }}
                        />
                      ) : openDiag ? (
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            openDiag.severity === 'error' ? 'bg-[#F24822]' : 'bg-[#D97706]'
                          }`}
                        />
                      ) : fixedDiag ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#14AE5C]" />
                      ) : null}
                      <span className="text-[11px] leading-[20px]">{lineNum}</span>
                      <span className="w-2.5 inline-flex justify-center opacity-0 group-hover:opacity-70 text-[#6B7078]">
                        {hasFold && <ChevronDown className="w-2.5 h-2.5" aria-hidden="true" />}
                      </span>
                    </span>

                    {/* Code Line + Indent Guides + Caret */}
                    <div className="flex-1 min-w-0 relative whitespace-pre">
                      {indentDepth > 0 &&
                        Array.from({ length: Math.min(indentDepth, 6) }).map((_, gIdx) => (
                          <span
                            key={gIdx}
                            aria-hidden="true"
                            style={{ left: `${gIdx * 2}ch` }}
                            className="absolute top-0 bottom-0 w-px bg-[#E0E2E5] pointer-events-none"
                          />
                        ))}

                      <span
                        className={
                          openDiag
                            ? `underline decoration-wavy ${
                                openDiag.severity === 'error'
                                  ? 'decoration-[#F24822]'
                                  : 'decoration-[#D97706]'
                              }`
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
                            style={{ left: `${agentCaretCol}ch` }}
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

                    {/* Inline ErrorLens Diagnostic Annotation */}
                    {openDiag && lineCursors.length === 0 && !isSplitActive && (
                      <span className="ml-6 inline-flex items-center gap-2 shrink-0 text-[11px] font-sans max-w-[340px]">
                        <span
                          className={`truncate ${
                            openDiag.severity === 'error' ? 'text-[#F24822]' : 'text-[#B45309]'
                          }`}
                        >
                          [{openDiag.code}] {openDiag.title}
                        </span>
                        {(openDiag.suggestedLinePatch || openDiag.suggestedFilePatch) && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onApplySingleFix(openDiag.id);
                            }}
                            className="px-2 py-0.5 rounded-[4px] bg-[#E6F4FF] hover:bg-[#0D99FF] text-[#0D99FF] hover:text-white text-[10px] font-medium shrink-0 transition-colors"
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

          {/* Proportional Code Minimap */}
          <div
            aria-label="Editor Minimap"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
              handleMinimapClick(ratio);
            }}
            className="w-[44px] bg-[#F8F9FA] border-l border-[#E0E2E5] py-2 px-1 shrink-0 cursor-pointer overflow-hidden relative select-none"
            title="Click minimap to jump"
          >
            <div className="space-y-[2px]">
              {codeLines.slice(0, 140).map((lineText, idx) => {
                const lineNum = idx + 1;
                const trimmed = lineText.trim();
                const hasError = fileDiagnostics.some((d) => d.line === lineNum && !d.fixed);
                const hasCursor = cursorsInFile.some((c) => c.line === lineNum);
                const activeCursor = cursorsInFile.find((c) => c.line === lineNum);
                const widthPct = trimmed.length === 0 ? 0 : Math.min(100, Math.max(18, Math.round((trimmed.length / 72) * 100)));

                let barColor = 'bg-[#D7DADE]';
                if (hasCursor && activeCursor) {
                  barColor = '';
                } else if (hasError) {
                  barColor = 'bg-[#F24822]';
                } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
                  barColor = 'bg-[#9DA2A9]';
                } else if (trimmed.startsWith('export') || trimmed.startsWith('import')) {
                  barColor = 'bg-[#0D99FF]/60';
                }

                return (
                  <div key={lineNum} className="h-[2.5px] flex items-center">
                    {widthPct > 0 && (
                      <div
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: hasCursor && activeCursor ? activeCursor.color : undefined,
                        }}
                        className={`h-full rounded-[0.5px] ${barColor}`}
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
