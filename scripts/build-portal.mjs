// Netlify build: copies the static site into dist/ and bundles the staff portal.
// The public pages need no build; only the staff portal does, because it uses the
// @netlify/identity package. Publishing dist/ (not the repo root) keeps node_modules,
// source files and tests off the live site.

import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Everything at the repo root is published except these.
const EXCLUDE = new Set([
  'dist', 'node_modules', 'netlify', 'scripts', 'portal-src', 'tests', '.git', '.github', '.netlify',
  'package.json', 'package-lock.json', 'netlify.toml', 'README.md', '.gitignore',
]);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const entry of await readdir(root)) {
  if (EXCLUDE.has(entry) || entry.startsWith('.')) continue;
  await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });
}

await build({
  entryPoints: {
    app: path.join(root, 'portal-src/admin/app.js'),
    login: path.join(root, 'portal-src/admin/login.js'),
    admin: path.join(root, 'portal-src/admin/admin.css'),
  },
  outdir: path.join(dist, 'assets/admin'),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  target: ['es2020', 'safari14'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
});

console.log('Built site into dist/');
