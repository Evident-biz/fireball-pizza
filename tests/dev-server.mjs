// Local preview of the whole system for manual/browser testing (not used by Netlify).
//   node --experimental-test-module-mocks tests/dev-server.mjs [port] [--seed]
// Serves a build of the site with the staff portal bundled against a fake signed-in owner,
// routes /api/* to the real functions, and stores data in a temporary local Blobs server.

import { mock } from 'node:test';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startBlobs, fakeExternalApis } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8888;
const FAKE_USER = { id: 'dev-owner', email: 'owner@fireball.test', confirmedAt: '2026-01-01', name: 'Paul', roles: ['admin'] };

mock.module('@netlify/identity', {
  namedExports: {
    getUser: async () => FAKE_USER,
    getIdentityConfig: () => null,
    admin: {
      listUsers: async () => [FAKE_USER, { id: 'dev-2', email: 'maria@fireball.test', confirmedAt: '2026-01-01', roles: ['staff'], userMetadata: { full_name: 'Maria' }, lastSignInAt: new Date().toISOString() }],
      getUser: async (id) => ({ id, email: 'maria@fireball.test', appMetadata: { roles: ['staff'] } }),
      updateUser: async () => ({}),
      deleteUser: async () => {},
    },
  },
});

await startBlobs();
fakeExternalApis();
Object.assign(process.env, { RESEND_API_KEY: 'dev', SQUARE_ACCESS_TOKEN: 'dev', SQUARE_LOCATION_ID: 'dev', URL: 'http://localhost:' + port });

const fn = async (name) => (await import('../netlify/functions/' + name + '.mjs')).default;
const routes = [
  ['/api/leads', await fn('leads')],
  ['/api/portal/', await fn('portal')],
  ['/api/admin/', await fn('admin-api')],
  ['/.netlify/functions/create-deposit-link', await fn('create-deposit-link')],
  ['/.netlify/functions/send-confirmation-email', await fn('send-confirmation-email')],
];

// Staff portal bundled with a stub Identity client that is always signed in.
const stubPath = path.join(root, 'tests', 'identity-browser-stub.mjs');
const bundles = {};
for (const name of ['app', 'login']) {
  const out = await build({
    entryPoints: [path.join(root, 'portal-src/admin', name + '.js')], bundle: true, write: false, format: 'iife',
    alias: { '@netlify/identity': stubPath },
  });
  bundles['/assets/admin/' + name + '.js'] = out.outputFiles[0].text;
}
const css = await build({ entryPoints: [path.join(root, 'portal-src/admin/admin.css')], bundle: true, write: false });
bundles['/assets/admin/admin.css'] = css.outputFiles[0].text;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + port);
  const route = routes.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix));
  if (route) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const response = await route[1](request, { deploy: { context: 'production' } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (bundles[url.pathname]) {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(url.pathname)] });
    return res.end(bundles[url.pathname]);
  }
  if (req.method === 'POST' && url.pathname === '/') { res.writeHead(200); return res.end('ok'); } // Netlify Forms
  let file = path.join(root, decodeURIComponent(url.pathname));
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => console.log('Fireball dev server on http://localhost:' + port));

if (process.argv.includes('--seed')) {
  const { seed } = await import('./seed.mjs');
  await seed('http://localhost:' + port);
}
