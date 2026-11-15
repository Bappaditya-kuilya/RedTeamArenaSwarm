import { useState } from 'react';
import {
  CheckCircle2,
  CircleDot,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type {
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  GitFileStatus,
} from '../types/ide';
import { VsCodeFileIcon } from './VsCodeFileIcon';

interface ComposerPanelProps {
  agentCount: number;
  cursorSpeed: CursorSpeed;
  autoFollowAgent: boolean;
  isSwarmFixing: boolean;
  isBuildingFeature: boolean;
  isImporting: boolean;
  hasWorkspace: boolean;
  openProblemCount: number;
  cursorAgents: CursorAgentState[];
  composerPlan: {
    prompt: string;
    summary: string;
    steps: ComposerPlanStep[];
  } | null;
  fileStatuses: Record<string, GitFileStatus>;
  onChangeAgentCount: (count: number) => void;
  onChangeCursorSpeed: (speed: CursorSpeed) => void;
  onToggleAutoFollow: () => void;
  onRunSwarmFix: () => void;
  onRunFeatureBuild: (prompt: string) => void;
  onJumpToFile: (filePath: string) => void;
  onShowDiff: () => void;
}

const FEATURE_PRESETS = [
  {
    label: 'Rate Limiter + Tests',
    prompt: 'Add a sliding-window RateLimiter middleware module with unit tests',
  },
  {
    label: 'Input Validation + Tests',
    prompt: 'Add input validation and HTML sanitizer helpers with unit tests',
  },
  {
    label: 'Audit Logger + Tests',
    prompt: 'Add a structured AuditLogger with secret redaction and unit tests',
  },
];

export function ComposerPanel({
  agentCount,
  cursorSpeed,
  autoFollowAgent,
  isSwarmFixing,
  isBuildingFeature,
  isImporting,
  hasWorkspace,
  openProblemCount,
  cursorAgents,
  composerPlan,
  fileStatuses,
  onChangeAgentCount,
  onChangeCursorSpeed,
  onToggleAutoFollow,
  onRunSwarmFix,
  onRunFeatureBuild,
  onJumpToFile,
  onShowDiff,
}: ComposerPanelProps) {
  const [promptInput, setPromptInput] = useState('');

  const busy = isSwarmFixing || isBuildingFeature || isImporting;
  const activeAgents = cursorAgents.filter((a) =>
    ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(a.status)
  );
  const activeCount = activeAgents.length;
  const isRunningTask = isSwarmFixing || isBuildingFeature;
  const lockstepFile = activeAgents.find((a) => a.filePath)?.filePath ?? null;
  const changedFiles = Object.entries(fileStatuses);

  const handleSubmitPrompt = () => {
    const trimmed = promptInput.trim();
    if (!trimmed || !hasWorkspace || busy) return;
    onRunFeatureBuild(trimmed);
  };

  return (
    <aside
      aria-label="Swarm Composer Panel"
      className="w-[300px] xl:w-[320px] bg-[#FFFFFF] border-l border-[#E0E2E5] flex flex-col min-h-0 shrink-0"
    >
      {/* Clean Header */}
      <div className="h-[36px] px-3 bg-[#F8F9FA] border-b border-[#E0E2E5] flex items-center justify-between gap-2 shrink-0">
        <span className="text-[12px] font-semibold text-[#121417]">
          Swarm Task Runner
        </span>

        <button
          type="button"
          onClick={onToggleAutoFollow}
          className={`h-6 px-2 text-[11px] font-medium rounded-[4px] border transition-colors ${
            autoFollowAgent
              ? 'bg-[#E6F4FF] border-[#0D99FF]/40 text-[#0D99FF]'
              : 'bg-[#FFFFFF] border-[#E0E2E5] text-[#6B7078]'
          }`}
          title="Keep editor view focused on the swarm's active file"
        >
          Follow: {autoFollowAgent ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Controls Row */}
      <div className="px-3 py-2 border-b border-[#E0E2E5] bg-[#FFFFFF] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] font-medium text-[#6B7078]" htmlFor="composer-agent-count">
            Cursors
          </label>
          <select
            id="composer-agent-count"
            aria-label="Cursor Count"
            value={agentCount}
            disabled={busy}
            onChange={(e) => onChangeAgentCount(Number(e.target.value))}
            className="h-7 px-2 text-[11.5px] font-mono rounded-[6px] bg-[#F8F9FA] border border-[#E0E2E5] text-[#121417] focus:outline-none focus:border-[#0D99FF]"
          >
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={20}>20</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[11px] font-medium text-[#6B7078]" htmlFor="composer-cursor-speed">
            Speed
          </label>
          <select
            id="composer-cursor-speed"
            aria-label="Cursor Speed"
            value={cursorSpeed}
            disabled={busy}
            onChange={(e) => onChangeCursorSpeed(e.target.value as CursorSpeed)}
            className="h-7 px-2 text-[11.5px] font-mono rounded-[6px] bg-[#F8F9FA] border border-[#E0E2E5] text-[#121417] focus:outline-none focus:border-[#0D99FF]"
          >
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </div>
      </div>

      {/* Prompt Input & Actions */}
      <div className="p-3 border-b border-[#E0E2E5] space-y-2.5 shrink-0 bg-[#FFFFFF]">
        <label htmlFor="composer-prompt-input" className="sr-only">
          Give all 20 cursors a task
        </label>
        <textarea
          id="composer-prompt-input"
          rows={3}
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSubmitPrompt();
            }
          }}
          placeholder="Give all 20 cursors one task — implement features, refactor modules, or add unit tests (⌘+Enter)…"
          className="w-full p-2.5 text-[12px] leading-snug rounded-[6px] bg-[#F8F9FA] border border-[#E0E2E5] text-[#121417] placeholder:text-[#6B7078] focus:outline-none focus:bg-[#FFFFFF] focus:border-[#0D99FF] resize-none"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!hasWorkspace || busy || promptInput.trim().length < 3}
            onClick={handleSubmitPrompt}
            className="flex-1 h-8 px-3 text-[12px] font-medium rounded-[6px] bg-[#121417] hover:bg-[#30343A] text-white disabled:opacity-45 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#0D99FF]" aria-hidden="true" />
            {isBuildingFeature ? `Converged (${activeCount})…` : 'Run Task'}
          </button>

          <button
            type="button"
            disabled={!hasWorkspace || busy}
            onClick={onRunSwarmFix}
            className="h-8 px-3 text-[12px] font-medium rounded-[6px] bg-[#0D99FF] hover:bg-[#0080E6] text-white disabled:opacity-45 inline-flex items-center gap-1.5 shrink-0 transition-colors whitespace-nowrap"
          >
            <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
            {isSwarmFixing
              ? `Fixing (${activeCount})…`
              : openProblemCount > 0
              ? `Fix (${openProblemCount})`
              : 'Fix Bugs'}
          </button>
        </div>

        {/* Clean Quick Presets */}
        <div className="flex flex-wrap gap-1.5">
          {FEATURE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={!hasWorkspace || busy}
              onClick={() => {
                setPromptInput(preset.prompt);
                onRunFeatureBuild(preset.prompt);
              }}
              className="px-2 py-1 text-[11px] font-medium rounded-[4px] bg-[#F8F9FA] hover:bg-[#E6F4FF] border border-[#E0E2E5] text-[#30343A] hover:text-[#0D99FF] hover:border-[#0D99FF]/40 disabled:opacity-45 transition-colors"
            >
              + {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable Plan, 20-Cursor Roster & Changed Files */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#E0E2E5] bg-[#FFFFFF]">
        {composerPlan && (
          <div className="p-3 space-y-2 bg-[#F8F9FA]">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-semibold text-[#121417]">Execution Plan</span>
              <span className="font-mono text-[11px] text-[#0D99FF] tabular-nums">
                {composerPlan.steps.filter((s) => s.status === 'done').length}/
                {composerPlan.steps.length} files
              </span>
            </div>
            <p className="text-[11.5px] text-[#30343A] leading-snug">{composerPlan.summary}</p>
            <div className="divide-y divide-[#E0E2E5] border border-[#E0E2E5] rounded-[6px] bg-[#FFFFFF] overflow-hidden">
              {composerPlan.steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => onJumpToFile(step.filePath)}
                  className="w-full px-2.5 py-1.5 hover:bg-[#F8F9FA] flex items-center justify-between gap-2 text-left transition-colors"
                >
                  <span className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
                    {step.status === 'done' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#14AE5C] shrink-0" aria-hidden="true" />
                    ) : (
                      <CircleDot className="w-3.5 h-3.5 text-[#0D99FF] shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate text-[#121417]">{step.filePath}</span>
                  </span>
                  <span className="text-[10px] font-mono text-[#6B7078] uppercase shrink-0">
                    {step.action}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 20-Cursor Roster */}
        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-semibold text-[#121417]">
              Swarm Cursors ({cursorAgents.length})
            </span>
            {isRunningTask && lockstepFile ? (
              <span className="text-[11px] font-mono text-[#0D99FF] truncate max-w-[155px]">
                {lockstepFile}
              </span>
            ) : (
              <span className="text-[11px] font-mono text-[#14AE5C]">
                {isRunningTask ? 'Converging…' : 'Roaming'}
              </span>
            )}
          </div>

          {!isRunningTask && !lockstepFile ? (
            <div className="grid grid-cols-2 gap-1.5">
              {cursorAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-[4px] bg-[#F8F9FA] border border-[#E0E2E5] text-[11px] text-[#30343A] min-w-0"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: agent.color }}
                  />
                  <span className="truncate font-medium">{agent.name}</span>
                  {agent.fixedCount > 0 && (
                    <span className="ml-auto font-mono text-[10px] text-[#14AE5C]">
                      +{agent.fixedCount}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-[#E0E2E5] border border-[#E0E2E5] rounded-[6px] overflow-hidden">
              {cursorAgents.map((agent) => {
                const isActive = [
                  'scanning',
                  'navigating',
                  'writing',
                  'editing',
                  'verifying',
                ].includes(agent.status);

                return (
                  <div
                    key={agent.id}
                    className={`px-2.5 py-1.5 transition-colors ${
                      isActive ? 'bg-[#F8F9FA]' : 'bg-[#FFFFFF]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex items-center gap-1.5 font-medium text-[#121417] min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: agent.color }}
                        />
                        <span className="truncate">{agent.name}</span>
                      </span>
                      {agent.filePath ? (
                        <button
                          type="button"
                          onClick={() => onJumpToFile(agent.filePath!)}
                          className="font-mono text-[10.5px] text-[#0D99FF] hover:underline truncate shrink-0 max-w-[125px]"
                        >
                          {agent.filePath}:{agent.line}
                        </button>
                      ) : (
                        <span className="font-mono text-[10.5px] text-[#6B7078]">
                          {agent.status}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5 text-[10.5px]">
                      <span className="text-[#6B7078] truncate">{agent.task}</span>
                      <span
                        className={`font-mono shrink-0 ${
                          agent.status === 'done'
                            ? 'text-[#14AE5C]'
                            : isActive
                            ? 'text-[#0D99FF]'
                            : 'text-[#8F949B]'
                        }`}
                      >
                        {agent.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Workspace Changes Summary */}
        {changedFiles.length > 0 && (
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] font-semibold text-[#121417]">
                Changed Files ({changedFiles.length})
              </span>
              <button
                type="button"
                onClick={onShowDiff}
                className="text-[11px] font-medium text-[#0D99FF] hover:underline"
              >
                Inspect Diff
              </button>
            </div>
            <div className="space-y-0.5">
              {changedFiles.map(([fp, status]) => (
                <button
                  key={fp}
                  type="button"
                  onClick={() => onJumpToFile(fp)}
                  className="w-full px-2 py-1 rounded-[4px] hover:bg-[#F8F9FA] flex items-center justify-between gap-2 text-left text-[11px] font-mono"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <VsCodeFileIcon filePath={fp} />
                    <span
                      className={`truncate ${
                        status === 'A' ? 'text-[#14AE5C]' : 'text-[#D97706]'
                      }`}
                    >
                      {fp}
                    </span>
                  </span>
                  <span
                    className={`font-bold shrink-0 ${
                      status === 'A' ? 'text-[#14AE5C]' : 'text-[#D97706]'
                    }`}
                  >
                    {status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
