export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type DiagnosticSource = 'typescript' | 'security' | 'bug' | 'test' | 'ai';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type GitFileStatus = 'M' | 'A';

export type CursorSpeed = 'slow' | 'normal' | 'fast';

export interface RepoFileNode {
  path: string;
  name: string;
  language: string;
  size: number;
  lineCount: number;
  diagnosticCount: number;
}

export interface IdeSubagent {
  id: string;
  name: string;
  specialty: string;
  color: string;
  status: 'idle' | 'running' | 'done' | 'error';
  elapsedMs: number;
  findingsCount: number;
  summary: string;
}

export type CursorAgentStatus =
  | 'idle'
  | 'scanning'
  | 'navigating'
  | 'writing'
  | 'editing'
  | 'verifying'
  | 'done'
  | 'error';

export interface CursorAgentState {
  id: string;
  name: string;
  color: string;
  status: CursorAgentStatus;
  filePath: string | null;
  line: number;
  column: number;
  task: string;
  diagnosticId: string | null;
  fixedCount: number;
  createdCount?: number;
  lastEditSnippet?: string;
}

export interface CodeDiagnostic {
  id: string;
  source: DiagnosticSource;
  severity: DiagnosticSeverity;
  code: string;
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  title: string;
  message: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  originalLine?: string;
  suggestedLinePatch?: string;
  suggestedFilePatch?: string;
  explanation: string;
  fixed: boolean;
  fixedByAgentId?: string;
  verified?: boolean;
}

export interface TestRunResult {
  ran: boolean;
  command: string;
  exitCode: number;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  output: string;
}

export interface TscRunResult {
  ran: boolean;
  filesChecked: number;
  errorCount: number;
  warningCount: number;
  durationMs: number;
  output: string;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  repoName: string;
  repoUrl: string;
  sourceType: 'github' | 'workspace' | 'custom' | 'demo';
  branch: string;
  files: RepoFileNode[];
  fileContents: Record<string, string>;
  fileStatuses?: Record<string, GitFileStatus>;
}

export interface DebugRunResponse {
  workspaceId: string;
  subagents: IdeSubagent[];
  diagnostics: CodeDiagnostic[];
  tscResult: TscRunResult;
  testResult: TestRunResult;
  terminalLines: string[];
  gitDiff: string;
  fileStatuses?: Record<string, GitFileStatus>;
  totalElapsedMs: number;
}

export interface ApplyFixResponse {
  workspaceId: string;
  appliedCount: number;
  updatedFiles: Record<string, string>;
  gitDiff: string;
  fileStatuses?: Record<string, GitFileStatus>;
  diagnostics: CodeDiagnostic[];
}

export interface ComposerPlanStep {
  id: string;
  filePath: string;
  action: 'create' | 'modify';
  description: string;
  agentId: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export type SwarmStreamEvent =
  | {
      type: 'phase';
      phase: 'diagnosing' | 'planning' | 'fixing' | 'writing' | 'verifying' | 'complete';
      message: string;
    }
  | {
      type: 'composer:plan';
      prompt: string;
      summary: string;
      steps: ComposerPlanStep[];
    }
  | {
      type: 'diagnostics:ready';
      diagnostics: CodeDiagnostic[];
      tscResult: TscRunResult;
      testResult: TestRunResult;
    }
  | {
      type: 'agent:update';
      agent: CursorAgentState;
      logLine?: string;
    }
  | {
      type: 'file:streaming';
      agentId: string;
      agentName: string;
      agentColor: string;
      filePath: string;
      line: number;
      column: number;
      content: string;
      action: 'create' | 'modify';
      files?: RepoFileNode[];
    }
  | {
      type: 'file:created';
      agentId: string;
      agentName: string;
      agentColor: string;
      filePath: string;
      content: string;
      files: RepoFileNode[];
      fileStatuses: Record<string, GitFileStatus>;
      gitDiff: string;
    }
  | {
      type: 'file:patched';
      agentId: string;
      agentName: string;
      agentColor: string;
      filePath: string;
      line: number;
      beforeLine: string;
      afterLine: string;
      content: string;
      gitDiff: string;
      fileStatuses?: Record<string, GitFileStatus>;
      diagnosticIds: string[];
    }
  | {
      type: 'file:reverted';
      agentId: string;
      filePath: string;
      reason: string;
      content: string;
      gitDiff: string;
    }
  | {
      type: 'swarm:complete';
      result: DebugRunResponse;
      agents: CursorAgentState[];
      fileContents: Record<string, string>;
      files?: RepoFileNode[];
      fileStatuses?: Record<string, GitFileStatus>;
      fixedCount: number;
      createdCount?: number;
      summary?: string;
    }
  | {
      type: 'error';
      message: string;
    };
