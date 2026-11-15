export interface SwarmCursorProfile {
  id: string;
  name: string;
  role: string;
  color: string;
}

// Inspired directly by califa/swarm-site cursor palette and computer science pioneer roster
export const SWARM_CURSOR_PROFILES: SwarmCursorProfile[] = [
  { id: 'agent-1', name: 'Ada', role: 'Fixer', color: '#0D99FF' },
  { id: 'agent-2', name: 'Linus', role: 'Type-Guard', color: '#14AE5C' },
  { id: 'agent-3', name: 'Grace', role: 'Patcher', color: '#9747FF' },
  { id: 'agent-4', name: 'Alan', role: 'Verifier', color: '#FF8A00' },
  { id: 'agent-5', name: 'Margaret', role: 'Sanitizer', color: '#F24E1E' },
  { id: 'agent-6', name: 'Ken', role: 'Refactor', color: '#00B5CE' },
  { id: 'agent-7', name: 'Barbara', role: 'Auditor', color: '#E8467C' },
  { id: 'agent-8', name: 'Dennis', role: 'Hardener', color: '#0ACF83' },
  { id: 'agent-9', name: 'Radia', role: 'Router', color: '#A259FF' },
  { id: 'agent-10', name: 'Guido', role: 'Parser', color: '#1ABCFE' },
  { id: 'agent-11', name: 'Frances', role: 'Optimizer', color: '#FF7262' },
  { id: 'agent-12', name: 'Bjarne', role: 'Compiler', color: '#D97706' },
  { id: 'agent-13', name: 'Hedy', role: 'Security', color: '#2563EB' },
  { id: 'agent-14', name: 'Tim', role: 'Linker', color: '#059669' },
  { id: 'agent-15', name: 'Katherine', role: 'Precision', color: '#7C3AED' },
  { id: 'agent-16', name: 'Edsger', role: 'Graph-Check', color: '#0284C7' },
  { id: 'agent-17', name: 'Joan', role: 'Decoder', color: '#E11D48' },
  { id: 'agent-18', name: 'Donald', role: 'Formatter', color: '#0D9488' },
  { id: 'agent-19', name: 'Sophie', role: 'Architect', color: '#4F46E5' },
  { id: 'agent-20', name: 'Niklaus', role: 'Reviewer', color: '#DC2626' },
];
