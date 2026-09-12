#!/usr/bin/env node
/**
 * Dead-code check for the DentalFlow backend.
 *
 * Reports three things, and fails the build on the first two:
 *
 *   1. Production files that nothing imports.
 *   2. Exported values (class/function/const/let/var) that nothing references
 *      outside their own file and that are not used inside it either.
 *   3. Advisory: exports referenced only by tests — usually a deliberate test
 *      seam, occasionally a leftover. Never fails the build.
 *
 * Types and interfaces are reported as advisory only: an exported type is a
 * legitimate part of a module's contract even when nothing imports it yet, and
 * deleting one buys nothing at runtime.
 *
 * Nest discovers controllers, services, guards and modules through decorator
 * metadata rather than imports, so anything decorated is never reported. Known
 * framework entry points are allow-listed below.
 *
 * Usage:  bun run deadcode
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

/** Entry points and framework-discovered files that no sibling imports. */
const ALLOWED_UNREFERENCED_FILES = new Set(['main.ts', 'app.module.ts']);

/**
 * Exports kept deliberately despite having no cross-file reference.
 * Each entry must carry a reason.
 */
const ALLOWED_UNUSED_EXPORTS = new Map([
  // Exported so the unit test can assert the pattern the decorator enforces,
  // while the decorator itself is the only runtime consumer.
  [
    'common/validators/input-validation.decorators.ts:SAFE_ID_PATTERN',
    'shared regex, used in-file',
  ],
  // loadEnvFiles is the public entry point; loadEnvFile stays exported so a
  // single file can be parsed in isolation by tests and tooling.
  [
    'config/env-file.loader.ts:loadEnvFile',
    'single-file parser used by tooling and tests',
  ],
  // Read-only mirror of the limiter's private constants so its spec asserts
  // against the real values instead of duplicating the literals.
  [
    'modules/auth/login-identity-rate-limiter.service.ts:loginIdentityRateLimitConfig',
    'deliberate test seam over the limiter constants',
  ],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const isSpec = (f) => f.endsWith('.spec.ts');
const prodFiles = files.filter((f) => !isSpec(f));
const rel = (f) => relative(SRC, f).replace(/\\/g, '/');

// ── 1. Files nothing imports ────────────────────────────────────────────────
const unreferencedFiles = [];
for (const file of prodFiles) {
  if (ALLOWED_UNREFERENCED_FILES.has(rel(file))) continue;
  const stem = basename(file, '.ts');
  const importRe = new RegExp(`['"][^'"]*/${stem}['"]|['"]\\./${stem}['"]`);
  const referenced = [...sources].some(
    ([other, src]) => other !== file && importRe.test(src),
  );
  if (!referenced) unreferencedFiles.push(rel(file));
}

// ── 2 & 3. Exported symbols ─────────────────────────────────────────────────
const EXPORT_RE =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

const unusedValueExports = [];
const unusedTypeExports = [];
const testOnlyExports = [];

for (const file of prodFiles) {
  const src = sources.get(file);
  EXPORT_RE.lastIndex = 0;
  let match;
  while ((match = EXPORT_RE.exec(src)) !== null) {
    const [, kind, name] = match;
    const key = `${rel(file)}:${name}`;
    if (ALLOWED_UNUSED_EXPORTS.has(key)) continue;

    const useRe = new RegExp(`\\b${name}\\b`, 'g');
    // Used within its own file (beyond the declaration itself)?
    const selfUses = (src.match(useRe) ?? []).length;
    if (selfUses > 1) continue;

    let inProd = false;
    let inSpec = false;
    for (const [other, otherSrc] of sources) {
      if (other === file) continue;
      if (!useRe.test(otherSrc)) continue;
      useRe.lastIndex = 0;
      if (isSpec(other)) inSpec = true;
      else inProd = true;
    }

    if (inProd) continue;
    if (inSpec) {
      testOnlyExports.push(`${key} (${kind})`);
    } else if (kind === 'type' || kind === 'interface') {
      unusedTypeExports.push(`${key} (${kind})`);
    } else {
      unusedValueExports.push(`${key} (${kind})`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
function section(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const item of items) console.log(`  ${item}`);
}

section(
  'Advisory — exported types with no cross-file reference:',
  unusedTypeExports,
);
section('Advisory — exports referenced only by tests:', testOnlyExports);
section('FAIL — production files nothing imports:', unreferencedFiles);
section('FAIL — exported values nothing references:', unusedValueExports);

const failures = unreferencedFiles.length + unusedValueExports.length;
if (failures > 0) {
  console.error(
    `\nDead-code check failed: ${failures} item(s).\n` +
      'Remove the code, or — if it is deliberately kept — add it to the\n' +
      'allow-list in scripts/check-dead-code.mjs with the reason why.',
  );
  process.exit(1);
}

console.log('\nDead-code check passed.');
