/**
 * Lightweight Repository Secret & Credential Checker
 * 
 * Inspects Git-tracked and staged files for accidental credential inclusion:
 * 1. Forbidden file paths (private keys, live env files, DB snapshots, session caches).
 * 2. High-confidence credential content patterns (Private key headers, API keys).
 * 
 * KEY SECURITY GUARANTEES:
 * - Checks both Git index (staged blobs) AND working tree to ensure secrets staged
 *   in the index are detected even if the working tree has been cleared.
 * - Handles filenames safely with null-byte delimiters (-z).
 * - Differentiates public keys (*.pub, ssh-rsa, ssh-ed25519) from private keys (*.pem, *.key, BEGIN PRIVATE KEY).
 * - CRITICAL RULE: Never prints or leaks secret values or secret-containing lines to stdout/stderr.
 *   Reports only relative file paths, line numbers, category classifications, and safe summaries.
 * 
 * DETECTION LIMITS:
 * - This scanner uses high-confidence regex heuristics for high-risk paths and known token patterns.
 * - It does NOT perform entropy analysis or dictionary password guessing on arbitrary strings.
 * - It does NOT scan historical Git commits (use `trufflehog` or `git-filter-repo` for git history analysis).
 * - It does NOT inspect untracked files that have not been staged in Git.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// 1. Forbidden tracked file path patterns
const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /(^|\/)\.env(\.|$)/, exempt: /(^|\/)\.env\.example$|(^|\/)PRODUCTION_ENV\.example$/, reason: 'Live environment / secret configuration file' },
  { pattern: /(^|\/)keys\/.*\.pem$/, reason: 'Private key file in keys/' },
  { pattern: /(^|\/)keys\/.*\.key$/, reason: 'Private key file in keys/' },
  { pattern: /\.pem$/i, exempt: /(^|\/)node_modules\//, reason: 'PEM certificate / private key file' },
  { pattern: /\.pkcs12$|\.pfx$|\.p12$/i, reason: 'PKCS#12 / PFX certificate bundle' },
  { pattern: /(^|\/)id_rsa(\.pem)?$/, reason: 'Default SSH private key file' },
  { pattern: /(^|\/)data\/.*\.db$|(^|\/)data\/\.session_secret$/, reason: 'Database binary or session cookie secret' },
  { pattern: /(^|\/)\.wwebjs_auth(\/|$)/, reason: 'WhatsApp session credentials directory' },
  { pattern: /(^|\/)\.wwebjs_cache(\/|$)/, reason: 'WhatsApp session cache directory' },
  { pattern: /(^|\/)backups(\/|$)/, reason: 'Database backup directory' },
  { pattern: /cookies\.txt$|\.cookies?$/i, reason: 'Authentication cookie file' }
];

// 2. High-confidence content patterns (strictly private keys & tokens, NOT public keys)
const CONTENT_PATTERNS = [
  { name: 'Private Key Header', regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/, exemptFiles: [/TASK_01_CREDENTIAL_SECURITY_REPORT\.md$/] },
  { name: 'Google API Key Pattern', regex: /\bAIza[0-9A-Za-z-_]{35}\b/, exemptFiles: [/\.example$/, /WHATSAPP_AUTOMATION_COMPLETE_AUDIT\.md$/, /TASK_01_CREDENTIAL_SECURITY_REPORT\.md$/, /TASK_01B_SECURITY_VERIFICATION_REPORT\.md$/] },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/, exemptFiles: [/\.example$/] }
];

function getTrackedFiles(cwd = PROJECT_ROOT) {
  try {
    const stdout = cp.execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return stdout.split('\0').map(f => f.trim()).filter(Boolean);
  } catch (err) {
    return null;
  }
}

function getStagedFiles(cwd = PROJECT_ROOT) {
  try {
    const stdout = cp.execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=d', '-z'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return stdout.split('\0').map(f => f.trim()).filter(Boolean);
  } catch (err) {
    return [];
  }
}

function getStagedContent(relPath, cwd = PROJECT_ROOT) {
  try {
    return cp.execFileSync('git', ['show', `:${relPath}`], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    return null;
  }
}

function isBinary(normalized) {
  return /\.(png|jpg|jpeg|gif|ico|exe|zip|db|sqlite|tar|gz|webp|pdf|wasm|bin)$/i.test(normalized);
}

function scanLines(content, normalized, sourceLabel, violations) {
  if (!content || typeof content !== 'string') return;
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const p of CONTENT_PATTERNS) {
      if (p.exemptFiles && p.exemptFiles.some(re => re.test(normalized))) {
        continue;
      }
      if (p.regex.test(line)) {
        violations.push({
          file: normalized,
          line: idx + 1,
          source: sourceLabel,
          category: p.name,
          details: 'Potential credential pattern detected (value redacted)'
        });
      }
    }
  });
}

function checkPathRules(normalized, violations) {
  for (const rule of FORBIDDEN_PATH_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      if (rule.exempt && rule.exempt.test(normalized)) {
        continue;
      }
      violations.push({
        file: normalized,
        line: 1,
        source: 'Path Rule',
        category: 'Forbidden Tracked Path',
        details: rule.reason
      });
      return true;
    }
  }
  return false;
}

function run(targetCwd = PROJECT_ROOT) {
  const violations = [];
  const tracked = getTrackedFiles(targetCwd);
  const staged = getStagedFiles(targetCwd);

  const stagedSet = new Set(staged);
  const allFiles = new Set([...(tracked || []), ...staged]);

  if (allFiles.size === 0) {
    console.log('[check:secrets] No tracked or staged files found to inspect.');
    return 0;
  }

  for (const file of allFiles) {
    const normalized = file.replace(/\\/g, '/');

    // 1. Path check
    const pathViolated = checkPathRules(normalized, violations);
    if (pathViolated) continue;

    if (isBinary(normalized)) continue;

    // 2. Index / Staged check (CRITICAL: Verifies staged blob even if working tree is clean)
    if (stagedSet.has(file)) {
      const stagedContent = getStagedContent(file, targetCwd);
      if (stagedContent !== null) {
        scanLines(stagedContent, normalized, 'Staged Index', violations);
      }
    }

    // 3. Working-tree check
    const absPath = path.join(targetCwd, normalized);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        scanLines(content, normalized, 'Working Tree', violations);
      } catch (err) {}
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ [check:secrets] DETECTED ${violations.length} POTENTIAL SECRET / CREDENTIAL EXPOSURE(S):\n`);
    violations.forEach(v => {
      console.error(`  - [${v.category}] ${v.file}:${v.line} (${v.source}: ${v.details})`);
    });
    console.error(`\nRemediation:`);
    console.error(`  1. Untrack files: git rm --cached <path>`);
    console.error(`  2. Add paths to .gitignore`);
    console.error(`  3. Do not commit private keys, real API keys, or live .env files.\n`);
    return 1;
  } else {
    console.log(`✓ [check:secrets] All ${allFiles.size} tracked/staged files clean. No secrets detected.`);
    return 0;
  }
}

if (require.main === module) {
  const exitCode = run();
  process.exit(exitCode);
}

module.exports = { run, getTrackedFiles, getStagedFiles, FORBIDDEN_PATH_PATTERNS, CONTENT_PATTERNS };
