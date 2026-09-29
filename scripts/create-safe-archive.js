#!/usr/bin/env node
/**
 * Safe Deployment Archive Generator
 *
 * Creates a clean, safe distribution/deployment zip archive.
 * Explicitly excludes:
 *   - .env, .env.* (except .env.example)
 *   - keys/, *.pem, *.key
 *   - data/, .wwebjs_auth/, .wwebjs_cache/
 *   - backups/, *.zip, *.tar.gz
 *   - tests/, scripts/dev/
 *   - logs, error files (*.log, *.err)
 *
 * Runs scripts/check-secrets.js prior to archive generation.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_ZIP = path.join(ROOT_DIR, 'dist', 'whatsapp-automation-clean.zip');

console.log('=== Safe Archive Packaging ===');

// 1. Run secret scanner first
console.log('1. Verifying repository secrets with check-secrets.js...');
try {
  cp.execSync('node scripts/check-secrets.js', { cwd: ROOT_DIR, stdio: 'inherit' });
} catch (e) {
  console.error('❌ Archive creation aborted: Secret scanner failed.');
  process.exit(1);
}

// 2. Prepare output directory
const distDir = path.dirname(OUTPUT_ZIP);
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// 3. Collect files to include using strict exclusion rules
const EXCLUDED_PATTERNS = [
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)\.env(?!\.example$)/,
  /(?:^|\/)keys(?:\/|$)/,
  /\.pem$/,
  /\.key$/,
  /\.pub$/,
  /(?:^|\/)data(?:\/|$)/,
  /(?:^|\/)\.wwebjs_auth(?:\/|$)/,
  /(?:^|\/)\.wwebjs_cache(?:\/|$)/,
  /\.session_secret/,
  /(?:^|\/)backups(?:\/|$)/,
  /\.zip$/,
  /\.tar\.gz$/,
  /\.tgz$/,
  /(?:^|\/)tests(?:\/|$)/,
  /(?:^|\/)scripts\/dev(?:\/|$)/,
  /scripts\/load-test-.*\.js$/,
  /scripts\/admin-test\.sh$/,
  /scripts\/reset-pending\.sh$/,
  /test_.*\.sh$/,
  /.*deploy.*\.sh$/,
  /.*deploy.*\.ps1$/,
  /check_users\.sh$/,
  /\.log$/,
  /\.err$/,
  /cookies\.txt$/,
  /(?:^|\/)gmail-src(?:\/|$)/,
  /_gmail\./,
  /(?:^|\/)dist(?:\/|$)/,
  /(?:^|\/)scratch(?:\/|$)/,
  /TASK_.*\.md$/,
  /WHATSAPP_AUTOMATION_COMPLETE_.*\.md$/,
  /AWS_.*\.md$/,
  /PROJECT_DEPLOYMENT_ANALYSIS\.md$/,
  /FINAL_PRODUCTION_AUDIT\.md$/
];

function getFiles(dir, baseDir = '') {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = path.join(baseDir, entry.name).replace(/\\/g, '/');
    const fullPath = path.join(dir, entry.name);

    if (EXCLUDED_PATTERNS.some(pat => pat.test(relPath))) {
      continue;
    }

    if (entry.isDirectory()) {
      results = results.concat(getFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

const filesToInclude = getFiles(ROOT_DIR);
console.log(`2. Collected ${filesToInclude.length} production files (all sensitive and non-production paths excluded).`);

// 4. Archive creation using Python zipfile
const manifestPath = path.join(distDir, 'package_manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(filesToInclude, null, 2), 'utf8');

const packScriptPath = path.join(distDir, 'pack.py');
const pythonScript = `import zipfile
import json
import os

with open(r"${manifestPath.replace(/\\/g, '\\\\')}", "r", encoding="utf-8") as f:
    files = json.load(f)

zip_path = r"${OUTPUT_ZIP.replace(/\\/g, '\\\\')}"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for item in files:
        z.write(item["fullPath"], item["relPath"])

print(f"Archive successfully written to: {zip_path}")
print(f"Total files packaged: {len(files)}")
`;

fs.writeFileSync(packScriptPath, pythonScript, 'utf8');

try {
  cp.execSync(`python "${packScriptPath}"`, { cwd: ROOT_DIR, stdio: 'inherit' });
  fs.unlinkSync(manifestPath);
  fs.unlinkSync(packScriptPath);
  console.log('✅ Safe archive creation completed successfully.');
} catch (e) {
  console.error('❌ Failed to create zip archive using python zipfile:', e.message);
  process.exit(1);
}
