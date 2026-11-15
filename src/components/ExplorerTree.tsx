import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ExplorerTreeNode } from '../engine/fileTree';
import type { CursorAgentState } from '../types/ide';
import { VsCodeFileIcon, VsCodeFolderIcon } from './VsCodeFileIcon';

interface ExplorerTreeProps {
  nodes: ExplorerTreeNode[];
  depth?: number;
  expandedFolders: Set<string>;
  activeFilePath: string;
  cursorAgents: CursorAgentState[];
  onToggleFolder: (folderPath: string) => void;
  onSelectFile: (filePath: string) => void;
}

export function ExplorerTree({
  nodes,
  depth = 0,
  expandedFolders,
  activeFilePath,
  cursorAgents,
  onToggleFolder,
  onSelectFile,
}: ExplorerTreeProps) {
  return (
    <div role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        const paddingLeft = 10 + depth * 12;

        if (node.kind === 'folder') {
          const isOpen = expandedFolders.has(node.path);
          return (
            <div key={node.path}>
              <button
                type="button"
                role="treeitem"
                aria-expanded={isOpen}
                onClick={() => onToggleFolder(node.path)}
                style={{ paddingLeft }}
                className="w-full h-[24px] pr-2 text-left text-[12px] flex items-center justify-between gap-1.5 text-[#30343A] hover:bg-[#F1F3F5] rounded-[4px] transition-colors"
              >
                <span className="flex items-center gap-1 min-w-0">
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[#6B7078] shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[#6B7078] shrink-0" aria-hidden="true" />
                  )}
                  <VsCodeFolderIcon expanded={isOpen} />
                  <span
                    className={`truncate font-medium ${
                      node.hasAdded
                        ? 'text-[#14AE5C]'
                        : node.hasModified
                        ? 'text-[#D97706]'
                        : 'text-[#121417]'
                    }`}
                  >
                    {node.name}
                  </span>
                </span>
                {node.errorCount > 0 && (
                  <span className="text-[10.5px] font-mono font-semibold text-[#F24822] tabular-nums shrink-0">
                    {node.errorCount}
                  </span>
                )}
              </button>
              {isOpen && (
                <div className="relative">
                  <span
                    aria-hidden="true"
                    style={{ left: paddingLeft + 6 }}
                    className="absolute top-0 bottom-0 w-px bg-[#E0E2E5]"
                  />
                  <ExplorerTree
                    nodes={node.children}
                    depth={depth + 1}
                    expandedFolders={expandedFolders}
                    activeFilePath={activeFilePath}
                    cursorAgents={cursorAgents}
                    onToggleFolder={onToggleFolder}
                    onSelectFile={onSelectFile}
                  />
                </div>
              )}
            </div>
          );
        }

        const isSelected = node.path === activeFilePath;
        const workingAgent = cursorAgents.find(
          (a) =>
            a.filePath === node.path &&
            ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(a.status)
        );
        const nameColor = isSelected
          ? 'text-[#0D99FF] font-medium'
          : node.gitStatus === 'A'
          ? 'text-[#14AE5C]'
          : node.gitStatus === 'M'
          ? 'text-[#D97706]'
          : node.errorCount > 0
          ? 'text-[#F24822]'
          : 'text-[#30343A]';

        return (
          <button
            key={node.path}
            type="button"
            role="treeitem"
            aria-selected={isSelected}
            onClick={() => onSelectFile(node.path)}
            style={{ paddingLeft: paddingLeft + 16 }}
            title={node.path}
            className={`w-full h-[24px] pr-2 text-left text-[12px] flex items-center justify-between gap-2 rounded-[4px] transition-colors ${
              isSelected
                ? 'bg-[#E6F4FF] text-[#0D99FF]'
                : 'text-[#30343A] hover:bg-[#F1F3F5]'
            }`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <VsCodeFileIcon filePath={node.path} />
              <span className={`truncate ${nameColor}`}>{node.name}</span>
            </span>

            <span className="flex items-center gap-1.5 shrink-0 font-mono text-[10px] tabular-nums">
              {workingAgent && (
                <span
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{ backgroundColor: workingAgent.color }}
                  title={`${workingAgent.name} is editing ${node.path}`}
                />
              )}
              {node.gitStatus === 'A' && (
                <span className="text-[#14AE5C] font-bold" title="Added / New File">
                  A
                </span>
              )}
              {node.gitStatus === 'M' && (
                <span className="text-[#D97706] font-bold" title="Modified">
                  M
                </span>
              )}
              {node.errorCount > 0 && (
                <span className="text-[#F24822] font-semibold">{node.errorCount}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
