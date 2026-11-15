import { FlaskConical, Folder, FolderOpen, FileText } from 'lucide-react';

export function VsCodeFileIcon({ filePath, className = 'w-3.5 h-3.5' }: { filePath: string; className?: string }) {
  const lower = filePath.toLowerCase();

  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(lower)) {
    return <FlaskConical className={`${className} text-[#059669] shrink-0`} aria-hidden="true" />;
  }
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[9px] font-mono font-bold text-[#2563EB] w-4 shrink-0"
        aria-hidden="true"
      >
        ⚛
      </span>
    );
  }
  if (lower.endsWith('.ts')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[8.5px] font-mono font-bold bg-[#2563EB] text-white rounded-[3px] w-3.5 h-3.5 leading-none shrink-0"
        aria-hidden="true"
      >
        TS
      </span>
    );
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[8.5px] font-mono font-bold bg-[#DBEAFE] text-[#1D4ED8] rounded-[3px] w-3.5 h-3.5 leading-none shrink-0"
        aria-hidden="true"
      >
        JS
      </span>
    );
  }
  if (lower.endsWith('.json')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[10px] font-mono font-bold text-[#6B7280] w-3.5 shrink-0"
        aria-hidden="true"
      >
        {'{}'}
      </span>
    );
  }
  if (lower.endsWith('.css') || lower.endsWith('.scss')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[9px] font-mono font-bold text-[#3B82F6] w-3.5 shrink-0"
        aria-hidden="true"
      >
        #
      </span>
    );
  }
  if (lower.endsWith('.html')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[9px] font-mono font-bold text-[#2563EB] w-3.5 shrink-0"
        aria-hidden="true"
      >
        &lt;&gt;
      </span>
    );
  }
  if (lower.endsWith('.md')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[9px] font-mono font-bold text-[#374151] w-3.5 shrink-0"
        aria-hidden="true"
      >
        M↓
      </span>
    );
  }
  if (lower.endsWith('.py')) {
    return (
      <span
        className="inline-flex items-center justify-center text-[8.5px] font-mono font-bold text-[#2563EB] w-3.5 shrink-0"
        aria-hidden="true"
      >
        PY
      </span>
    );
  }
  return <FileText className={`${className} text-[#6B7280] shrink-0`} aria-hidden="true" />;
}

export function VsCodeFolderIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <FolderOpen className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" aria-hidden="true" />
  ) : (
    <Folder className="w-3.5 h-3.5 text-[#6B7280] shrink-0" aria-hidden="true" />
  );
}
