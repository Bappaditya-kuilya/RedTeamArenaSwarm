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
  const activeFile = activeAgents.find((a) => a.filePath)?.filePath ?? null;
  const changedFiles = Object.entries(fileStatuses);

  const handleSubmitPrompt = () => {
    const trimmed = promptInput.trim();
    if (!trimmed || !hasWorkspace || busy) return;
    onRunFeatureBuild(trimmed);
  };

  return (
    <aside
      aria-label="Swarm Task Panel"
      className="w-[300px] xl:w-[320px] bg-[#252526] border-l border-[#2b2b2b] flex flex-col min-h-0 shrink-0"
    >
      <div className="h-[35px] px-3 bg-[#252526] border-b border-[#1e1e1e] flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] font-semibold tracking-wide uppercase text-[#bbbbbb]">Task & Swarm</span>
        <button
          type="button"
          onClick={onToggleAutoFollow}
          className={`h-6 px-2 text-[11px] rounded border transition-colors ${
            autoFollowAgent
              ? 'bg-[#094771] border-[#007acc] text-[#ffffff]'
              : 'bg-[#3c3c3c] border-[#3c3c3c] text-[#cccccc] hover:bg-[#4c4c4c]'
          }`}
          title="Keep view following active work"
        >
          Follow: {autoFollowAgent ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="px-3 py-2 border-b border-[#1e1e1e] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <label className="text-[12px] text-[#969696]" htmlFor="composer-agent-count">
            Cursors
          </label>
          <select
            id="composer-agent-count"
            aria-label="Cursor Count"
            value={agentCount}
            disabled={busy}
            onChange={(e) => onChangeAgentCount(Number(e.target.value))}
            className="h-7 px-2 text-[12px] rounded bg-[#3c3c3c] border border-[#3c3c3c] text-[#cccccc] focus:outline-none focus:border-[#007acc]"
          >
            {[1, 2, 4, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[12px] text-[#969696]" htmlFor="composer-cursor-speed">
            Speed
          </label>
          <select
            id="composer-cursor-speed"
            aria-label="Cursor Speed"
            value={cursorSpeed}
            disabled={busy}
            onChange={(e) => onChangeCursorSpeed(e.target.value as CursorSpeed)}
            className="h-7 px-2 text-[12px] rounded bg-[#3c3c3c] border border-[#3c3c3c] text-[#cccccc] focus:outline-none focus:border-[#007acc]"
          >
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </div>
      </div>

      <div className="p-3 border-b border-[#1e1e1e] space-y-2.5 shrink-0">
        <p className="text-[12px] text-[#969696] leading-snug">
          Work runs one file at a time. Confirm results in output and checks.
        </p>
        <label htmlFor="composer-prompt-input" className="sr-only">
          Give cursors a task
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
          placeholder="Describe a task for the swarm… (⌘+Enter)"
          className="w-full p-2.5 text-[13px] leading-snug rounded bg-[#3c3c3c] border border-[#3c3c3c] text-[#cccccc] placeholder:text-[#858585] focus:outline-none focus:border-[#007acc] resize-none"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!hasWorkspace || busy || promptInput.trim().length < 3}
            onClick={handleSubmitPrompt}
            className="flex-1 h-8 px-3 text-[12px] font-medium rounded bg-[#0e639c] hover:bg-[#1177bb] text-white disabled:opacity-45 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
            title="Run the requested task"
          >
            <Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            {isBuildingFeature ? `Running… (${activeCount || 10})` : 'Run Task'}
          </button>

          <button
            type="button"
            disabled={!hasWorkspace || busy}
            onClick={onRunSwarmFix}
            className="h-8 px-3 text-[12px] font-medium rounded bg-[#007acc] hover:bg-[#1f8ad2] text-white disabled:opacity-45 inline-flex items-center gap-1.5 shrink-0 transition-colors whitespace-nowrap"
            title="Repair open issues"
          >
            <Wrench className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
            {isSwarmFixing ? 'Repairing…' : openProblemCount > 0 ? `Fix (${openProblemCount})` : 'Repair'}
          </button>
        </div>

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
              className="px-2 py-1 text-[11px] rounded bg-[#3c3c3c] hover:bg-[#094771] border border-transparent text-[#cccccc] hover:text-white disabled:opacity-45 transition-colors"
            >
              + {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-[#1e1e1e]">
        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-[#cccccc]">Active File</span>
            {activeFile ? (
              <button
                type="button"
                onClick={() => onJumpToFile(activeFile)}
                className="text-[11px] font-mono text-[#3794ff] hover:underline truncate max-w-[170px]"
                title={activeFile}
              >
                {activeFile}
              </button>
            ) : (
              <span className="text-[11px] font-mono text-[#858585]">
                {isRunningTask ? 'Selecting…' : 'Idle'}
              </span>
            )}
          </div>
          <p className="text-[12px] text-[#969696] leading-snug">
            Scan → navigate → edit → verify, one file at a time.
          </p>
        </div>

        {composerPlan && (
          <div className="p-3 space-y-2 bg-[#1e1e1e]/40">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-semibold text-[#cccccc]">Execution Plan</span>
              <span className="font-mono text-[11px] text-[#3794ff] tabular-nums">
                {composerPlan.steps.filter((s) => s.status === 'done').length}/
                {composerPlan.steps.length}
              </span>
            </div>
            <p className="text-[12px] text-[#969696] leading-snug">{composerPlan.summary}</p>
            <div className="divide-y divide-[#2b2b2b] border border-[#2b2b2b] rounded overflow-hidden bg-[#252526]">
              {composerPlan.steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => onJumpToFile(step.filePath)}
                  className="w-full px-2.5 py-1.5 hover:bg-[#2a2d2e] flex items-center justify-between gap-2 text-left transition-colors"
                >
                  <span className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
                    {step.status === 'done' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#89d185] shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <CircleDot className="w-3.5 h-3.5 text-[#3794ff] shrink-0" strokeWidth={1.75} aria-hidden="true" />
                    )}
                    <span className="truncate text-[#cccccc]">{step.filePath}</span>
                  </span>
                  <span className="text-[10px] font-mono text-[#858585] uppercase shrink-0">
                    {step.action}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-[#cccccc]">Cursor Agents</span>
            <span className="text-[11px] font-mono text-[#858585]">{activeCount} active</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {cursorAgents.map((agent) => {
              const isActive = ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(
                agent.status
              );
              return (
                <div
                  key={agent.id}
                  className={`px-2 py-1.5 rounded border text-[11px] min-w-0 ${
                    isActive ? 'bg-[#094771]/30 border-[#007acc]/40' : 'bg-[#2d2d2d] border-[#3c3c3c]'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className={`font-mono uppercase ${isActive ? 'text-[#4fc1ff]' : 'text-[#858585]'}`}>
                      {agent.status}
                    </span>
                    {agent.fixedCount > 0 && (
                      <span className="ml-auto font-mono text-[10px] text-[#89d185]">+{agent.fixedCount}</span>
                    )}
                  </div>
                  {agent.filePath && (
                    <button
                      type="button"
                      onClick={() => onJumpToFile(agent.filePath!)}
                      className="mt-0.5 block w-full text-left font-mono text-[10.5px] text-[#969696] hover:text-[#3794ff] truncate"
                      title={`${agent.filePath}:${agent.line}`}
                    >
                      {agent.filePath.split('/').pop()}:{agent.line}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {changedFiles.length > 0 && (
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[#cccccc]">
                Changes ({changedFiles.length})
              </span>
              <button
                type="button"
                onClick={onShowDiff}
                className="text-[11px] text-[#3794ff] hover:underline"
              >
                Open Diff
              </button>
            </div>
            <div className="space-y-0.5">
              {changedFiles.map(([fp, status]) => (
                <button
                  key={fp}
                  type="button"
                  onClick={() => onJumpToFile(fp)}
                  className="w-full px-2 py-1 rounded hover:bg-[#2a2d2e] flex items-center justify-between gap-2 text-left text-[12px] font-mono"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <VsCodeFileIcon filePath={fp} className="w-3.5 h-3.5" />
                    <span
                      className={`truncate ${
                        status === 'A' ? 'text-[#81b88b]' : 'text-[#e2c08d]'
                      }`}
                    >
                      {fp}
                    </span>
                  </span>
                  <span
                    className={`font-semibold shrink-0 ${
                      status === 'A' ? 'text-[#81b88b]' : 'text-[#e2c08d]'
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
