import { Braces, FileCode2, FileJson, FileText, FileType, Folder, FolderOpen, FlaskConical, Hash, Terminal } from 'lucide-react';

export function VsCodeFileIcon({ filePath, className = 'w-4 h-4' }: { filePath: string; className?: string }) {
  const lower = filePath.toLowerCase();
  const name = lower.split('/').pop() ?? lower;

  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(lower)) {
    return <FlaskConical className={`${className} text-[#73c991] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return <FileCode2 className={`${className} text-[#4fc1ff] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.ts')) {
    return <FileType className={`${className} text-[#519aba] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return <FileCode2 className={`${className} text-[#cbcb41] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (name === 'package.json' || name === 'tsconfig.json' || lower.endsWith('.json')) {
    return <FileJson className={`${className} text-[#cbcb41] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.sass')) {
    return <Hash className={`${className} text-[#519aba] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.html')) {
    return <Braces className={`${className} text-[#e37933] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.md')) {
    return <FileText className={`${className} text-[#519aba] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.py')) {
    return <FileCode2 className={`${className} text-[#3572A5] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) {
    return <Terminal className={`${className} text-[#89d185] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
  }
  return <FileText className={`${className} text-[#cccccc] shrink-0`} strokeWidth={1.75} aria-hidden="true" />;
}

export function VsCodeFolderIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen className="w-4 h-4 text-[#dcb67a] shrink-0" strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <Folder className="w-4 h-4 text-[#dcb67a] shrink-0" strokeWidth={1.75} aria-hidden="true" />
  );
}
