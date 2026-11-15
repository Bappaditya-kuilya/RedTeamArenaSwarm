import type { GitFileStatus, RepoFileNode } from '../types/ide';

export interface ExplorerFolderNode {
  kind: 'folder';
  name: string;
  path: string;
  children: ExplorerTreeNode[];
  errorCount: number;
  hasModified: boolean;
  hasAdded: boolean;
}

export interface ExplorerFileTreeNode {
  kind: 'file';
  name: string;
  path: string;
  language: string;
  lineCount: number;
  errorCount: number;
  gitStatus?: GitFileStatus;
}

export type ExplorerTreeNode = ExplorerFolderNode | ExplorerFileTreeNode;

export interface WorkspaceSearchMatch {
  filePath: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export function buildExplorerTree(
  files: RepoFileNode[],
  diagnosticsByFile: Map<string, number>,
  fileStatuses: Record<string, GitFileStatus> = {}
): ExplorerTreeNode[] {
  interface MutableFolder {
    name: string;
    path: string;
    folders: Map<string, MutableFolder>;
    files: ExplorerFileTreeNode[];
  }

  const root: MutableFolder = {
    name: '',
    path: '',
    folders: new Map(),
    files: [],
  };

  for (const file of files) {
    const cleanPath = file.path.replace(/^\/+/, '');
    const parts = cleanPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      let folder = current.folders.get(segment);
      if (!folder) {
        folder = {
          name: segment,
          path: nextPath,
          folders: new Map(),
          files: [],
        };
        current.folders.set(segment, folder);
      }
      current = folder;
    }

    const fileName = parts[parts.length - 1];
    current.files.push({
      kind: 'file',
      name: fileName,
      path: cleanPath,
      language: file.language,
      lineCount: file.lineCount,
      errorCount: diagnosticsByFile.get(cleanPath) ?? 0,
      gitStatus: fileStatuses[cleanPath],
    });
  }

  function finalize(folder: MutableFolder): ExplorerTreeNode[] {
    const folderNodes: ExplorerFolderNode[] = Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => {
        const children = finalize(sub);
        let errorCount = 0;
        let hasModified = false;
        let hasAdded = false;
        for (const ch of children) {
          errorCount += ch.errorCount;
          if (ch.kind === 'folder') {
            if (ch.hasModified) hasModified = true;
            if (ch.hasAdded) hasAdded = true;
          } else {
            if (ch.gitStatus === 'M') hasModified = true;
            if (ch.gitStatus === 'A') hasAdded = true;
          }
        }
        return {
          kind: 'folder',
          name: sub.name,
          path: sub.path,
          children,
          errorCount,
          hasModified,
          hasAdded,
        };
      });

    const sortedFiles = [...folder.files].sort((a, b) => a.name.localeCompare(b.name));
    return [...folderNodes, ...sortedFiles];
  }

  return finalize(root);
}

export function collectAllFolderPaths(nodes: ExplorerTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      paths.push(node.path);
      paths.push(...collectAllFolderPaths(node.children));
    }
  }
  return paths;
}

export function searchWorkspaceFiles(
  fileContents: Record<string, string>,
  rawQuery: string,
  caseSensitive = false,
  maxMatches = 120
): WorkspaceSearchMatch[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: WorkspaceSearchMatch[] = [];

  for (const filePath of Object.keys(fileContents).sort()) {
    const content = fileContents[filePath] ?? '';
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const haystack = caseSensitive ? lineText : lineText.toLowerCase();
      const idx = haystack.indexOf(needle);
      if (idx !== -1) {
        matches.push({
          filePath,
          line: i + 1,
          column: idx + 1,
          lineText,
          matchStart: idx,
          matchEnd: idx + needle.length,
        });
        if (matches.length >= maxMatches) return matches;
      }
    }
  }

  return matches;
}
