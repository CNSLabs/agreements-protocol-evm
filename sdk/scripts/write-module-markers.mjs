#!/usr/bin/env node
/**
 * Stamps each dual-publish output directory with a module-type marker.
 *
 * Node decides whether a `.js` file is CommonJS or ESM from the nearest
 * enclosing `package.json` `type` field. Without these markers, Node parses
 * `dist/esm/*.js` as CommonJS (the root package.json declares no `type`) and
 * native-ESM consumers fail with `SyntaxError: Unexpected token 'export'`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const markers = [
  ['../dist/esm/package.json', { type: 'module' }],
  ['../dist/cjs/package.json', { type: 'commonjs' }],
];

for (const [relativePath, marker] of markers) {
  const target = fileURLToPath(new URL(relativePath, import.meta.url));
  writeFileSync(target, `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`wrote ${target}`);
}
