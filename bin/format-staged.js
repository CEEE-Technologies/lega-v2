#!/usr/bin/env node
/**
 * Pre-commit: formats only the staged files, with each package's own
 * prettier and config (the same as its `format` script), and stages only
 * those files again. Untracked and unstaged files are never touched.
 *
 * A staged file that also has unstaged changes is not formatted: re-staging
 * it would stage those changes too. It is listed, so it can be formatted by
 * hand (`pnpm format` in the package) before committing.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const PACKAGES = [
  {
    dir: 'packages/server',
    // As `format` in packages/server: "src/**/*.ts" "test/**/*.ts".
    matches: /^packages\/server\/(src|test)\/.+\.ts$/,
  },
  {
    dir: 'packages/webapp',
    // As `format` in packages/webapp: "src/**/*.{ts,tsx,js,jsx,json,md}".
    matches: /^packages\/webapp\/src\/.+\.(ts|tsx|js|jsx|json|md)$/,
  },
];

/** Files per prettier / git call. */
const BATCH = 100;

const gitList = (args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

const staged = gitList([
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
  '-z',
]);
const unstaged = new Set(gitList(['diff', '--name-only', '-z']));

const skipped = [];
for (const { dir, matches } of PACKAGES) {
  const files = staged.filter((file) => matches.test(file));
  const whole = files.filter((file) => !unstaged.has(file));
  skipped.push(...files.filter((file) => unstaged.has(file)));
  if (whole.length === 0) continue;

  // Runs the package's own prettier through node (no shell, no .bin shim,
  // so it works on Windows too), in batches so a large commit stays under
  // the command-line length limit.
  const pkgDir = path.join(root, dir);
  const prettierPkg = require.resolve('prettier/package.json', {
    paths: [pkgDir],
  });
  const { bin } = require(prettierPkg);
  const prettierBin = path.join(
    path.dirname(prettierPkg),
    typeof bin === 'string' ? bin : bin.prettier,
  );
  for (let i = 0; i < whole.length; i += BATCH) {
    const batch = whole.slice(i, i + BATCH);
    execFileSync(
      process.execPath,
      [prettierBin, '--write', ...batch.map((file) => path.relative(dir, file))],
      { cwd: pkgDir, stdio: 'inherit' },
    );
    execFileSync('git', ['add', '--', ...batch], { cwd: root });
  }
}

if (skipped.length > 0) {
  console.warn(
    'format-staged: not formatted (they also have unstaged changes):\n' +
      skipped.map((file) => `  ${file}`).join('\n'),
  );
}
