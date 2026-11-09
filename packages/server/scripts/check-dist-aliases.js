#!/usr/bin/env node
/**
 * Fails the build when the compiled output still requires the `@/` path
 * alias. The build rewrites `@/` only in static imports; a dynamic
 * `import('@/...')` compiles to `require('@/...')`, which can't be found
 * when the server or the CLI runs from dist (Docker, production).
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const pattern = /require\(\s*['"]@\//;
const found = [];

const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      walk(full);
    } else if (full.endsWith('.js')) {
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (pattern.test(line)) {
            found.push(`${path.relative(dist, full)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
  }
};

if (!fs.existsSync(dist)) {
  console.error('check-dist-aliases: no dist folder; run the build first.');
  process.exit(1);
}
walk(dist);
if (found.length > 0) {
  console.error(
    "The build output still requires the '@/' alias (use a relative path in dynamic imports):",
  );
  found.forEach((line) => console.error(`  ${line}`));
  process.exit(1);
}
console.log('check-dist-aliases: no @/ requires left in dist.');
