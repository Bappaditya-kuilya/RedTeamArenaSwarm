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
        const paddingLeft = 8 + depth * 10;

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
                className="w-full h-[22px] pr-2 text-left text-[13px] flex items-center justify-between gap-1.5 text-[#cccccc] hover:bg-[#2a2d2e] transition-colors"
              >
                <span className="flex items-center gap-1 min-w-0">
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-[#cccccc] shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[#cccccc] shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  )}
                  <VsCodeFolderIcon expanded={isOpen} />
                  <span
                    className={`truncate ${
                      node.hasAdded
                        ? 'text-[#81b88b]'
                        : node.hasModified
                        ? 'text-[#e2c08d]'
                        : 'text-[#cccccc]'
                    }`}
                  >
                    {node.name}
                  </span>
                </span>
                {node.errorCount > 0 && (
                  <span className="text-[11px] font-mono text-[#f14c4c] tabular-nums shrink-0">
                    {node.errorCount}
                  </span>
                )}
              </button>
              {isOpen && (
                <div className="relative">
                  <span
                    aria-hidden="true"
                    style={{ left: paddingLeft + 7 }}
                    className="absolute top-0 bottom-0 w-px bg-[#404040]"
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
        const nameColor = node.gitStatus === 'A'
          ? 'text-[#81b88b]'
          : node.gitStatus === 'M'
          ? 'text-[#e2c08d]'
          : node.errorCount > 0
          ? 'text-[#f48771]'
          : 'text-[#cccccc]';

        return (
          <button
            key={node.path}
            type="button"
            role="treeitem"
            aria-selected={isSelected}
            onClick={() => onSelectFile(node.path)}
            style={{ paddingLeft: paddingLeft + 18 }}
            title={node.path}
            className={`w-full h-[22px] pr-2 text-left text-[13px] flex items-center justify-between gap-2 transition-colors ${
              isSelected
                ? 'bg-[#37373d] text-[#ffffff]'
                : 'hover:bg-[#2a2d2e]'
            }`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <VsCodeFileIcon filePath={node.path} />
              <span className={`truncate ${nameColor}`}>{node.name}</span>
            </span>

            <span className="flex items-center gap-1.5 shrink-0 font-mono text-[11px] tabular-nums">
              {workingAgent && (
                <span
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{ backgroundColor: workingAgent.color }}
                  title={`${workingAgent.name} is editing ${node.path}`}
                />
              )}
              {node.gitStatus === 'A' && (
                <span className="text-[#81b88b] font-semibold" title="Added / New File">
                  A
                </span>
              )}
              {node.gitStatus === 'M' && (
                <span className="text-[#e2c08d] font-semibold" title="Modified">
                  M
                </span>
              )}
              {node.errorCount > 0 && (
                <span className="text-[#f14c4c]">{node.errorCount}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
