// Run inside the built container (no model credentials or paid inference needed):
// docker compose ... exec -T app node --input-type=module - write < scripts/docker-smoke.mjs
// Recreate the container, then repeat with "verify" to prove volume persistence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import WebSocket from '/app/node_modules/ws/index.js';

const phase = process.argv[2] || 'write';
assert.ok(['write', 'verify', 'https'].includes(phase), 'Expected write, verify or https phase');
assert.equal(process.getuid(), 1000, 'Application must run as UID 1000');
assert.equal(process.cwd(), '/workspace');
for (const command of ['codex', 'git', 'ssh', 'tmux', 'bash', 'python3', 'rg']) {
  assert.equal(spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'check', command]).status, 0, `${command} must be installed`);
}
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0);
assert.match(version.stdout, /codex(?:-cli)? 0\.159\.2\b/);
const base = 'http://127.0.0.1:8787';
const origin = phase === 'https' ? 'https://codex-smoke.example' : base;
const password = process.env.CODEX_WEB_PASSWORD;
assert.ok(password && password.length >= 12, 'Explicit test password required');
const jsonHeaders = { 'content-type': 'application/json', origin };
assert.equal((await fetch(base + '/api/health')).status, 200);
assert.equal((await fetch(base + '/api/bootstrap')).status, 401);
assert.equal((await (await fetch(base + '/api/auth/session')).json()).authenticated, false);
assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password: 'incorrect-test-password' }) })).status, 401);
assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...jsonHeaders, origin: 'https://untrusted.example' }, body: JSON.stringify({ password }) })).status, 403);
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password }) });
assert.equal(login.status, 200);
const setCookie = login.headers.get('set-cookie');
assert.ok(setCookie);
assert.match(setCookie, /HttpOnly/i);
assert.match(setCookie, /SameSite=Strict/i);
assert.equal(/;\s*Secure(?:;|$)/i.test(setCookie), phase === 'https', 'HTTP cookies must work locally; HTTPS cookies must be Secure');
const cookie = setCookie.split(';')[0];
const { csrfToken } = await login.json();
assert.ok(csrfToken);
const headers = { ...jsonHeaders, cookie, 'x-csrf-token': csrfToken };
assert.equal((await (await fetch(base + '/api/auth/session', { headers: { cookie } })).json()).authenticated, true);
assert.equal((await fetch(base + '/api/preferences', { method: 'PATCH', headers: { ...jsonHeaders, cookie }, body: '{}' })).status, 403);
assert.equal((await fetch(base + '/api/preferences', { method: 'PATCH', headers: { ...headers, origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
const html = await fetch(base + '/');
assert.equal(html.status, 200);
const htmlText = await html.text();
assert.match(htmlText, /<!doctype html>/i);
const asset = htmlText.match(/(?:src|href)="(\/assets\/[^" ]+)"/)?.[1];
assert.ok(asset, 'Built frontend must be served when cwd is /workspace');
assert.equal((await fetch(base + asset)).status, 200);
const manifestResponse = await fetch(base + '/manifest.webmanifest');
assert.equal(manifestResponse.status, 200, 'The non-root server must read copied public assets');
const manifest = await manifestResponse.json();
for (const assetPath of ['/sw.js', '/offline.html', '/favicon.svg', ...manifest.icons.map(icon => icon.src)]) {
  assert.equal((await fetch(base + assetPath)).status, 200, `Public asset ${assetPath} must be readable`);
}
JSON.parse(await fs.readFile('/app/package.json', 'utf8'));
const bootstrap = await (await fetch(base + '/api/bootstrap', { headers })).json();
assert.equal(bootstrap.cwd, '/workspace');
assert.equal(bootstrap.codexHome, '/home/node/.codex');

if (phase === 'https') {
  // Simulate the trusted TLS reverse proxy without obtaining a public certificate.
  const proxied = await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...jsonHeaders, 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password }) });
  assert.equal(proxied.status, 200);
  assert.match(proxied.headers.get('set-cookie'), /;\s*Secure(?:;|$)/i);
  console.log('Docker HTTPS origin / Secure cookie checks passed.');
  process.exit(0);
}

async function deniedSocket(socketHeaders, expected) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:8787/api/rpc', { headers: socketHeaders });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Denied WebSocket did not respond')); }, 5000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
    socket.once('open', () => { clearTimeout(timer); socket.close(); reject(new Error('Unauthenticated/untrusted WebSocket was accepted')); });
    socket.on('error', () => {});
  });
}
await deniedSocket({ origin }, 401);
await deniedSocket({ origin: 'https://untrusted.example', cookie }, 403);

const socket = new WebSocket('ws://127.0.0.1:8787/api/rpc?host=local&clientId=docker_smoke_client', { headers: { origin, cookie } });
const pending = new Map();
const notifications = [];
let nextId = 0;
socket.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (message.id !== undefined && !message.method) {
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    }
  } else notifications.push(message);
});
socket.on('error', error => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear();
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
  pending.set(id, { method, resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label);
}
async function api(endpoint, body) {
  const response = await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.ok(response.ok, `${endpoint}: HTTP ${response.status}`);
  return response.json();
}
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await until(() => notifications.some(message => message.method === 'bridge/status' && message.params?.connected), 'Official app-server did not complete initialize / initialized');
  const configuration = await rpc('config/read', { cwd: '/workspace', includeLayers: false });
  assert.equal(typeof configuration.config, 'object');
  const metadata = await rpc('fs/getMetadata', { path: '/workspace' });
  assert.equal(metadata.isDirectory, true);
  const marker = 'CODEX_DOCKER_PERSISTENCE_OK\n';
  const markerPath = '/workspace/.codex-docker-smoke.txt';
  const homeMarker = '/home/node/.codex/.docker-smoke.txt';
  if (phase === 'write') {
    await rpc('fs/writeFile', { path: markerPath, dataBase64: Buffer.from(marker).toString('base64') });
    await fs.writeFile(homeMarker, marker, { mode: 0o600 });
    const preferences = await fetch(base + '/api/preferences', { method: 'PATCH', headers, body: JSON.stringify({ collapsed: { 'docker-smoke': true } }) });
    assert.equal(preferences.status, 200);
  } else {
    assert.equal(await fs.readFile(homeMarker, 'utf8'), marker, 'Codex home volume did not persist');
    assert.equal(bootstrap.preferences.collapsed['docker-smoke'], true, 'Web metadata volume did not persist');
  }
  const read = await rpc('fs/readFile', { path: markerPath });
  assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), marker, 'Workspace bind did not persist');

  // The smoke explicitly tests container-bound full access, without disabling
  // Docker's seccomp profile or claiming host-dependent Codex Linux sandboxes.
  const processId = `docker-smoke-pty-${Date.now()}`;
  const output = () => notifications
    .filter(message => message.method === 'command/exec/outputDelta' && message.params?.processId === processId)
    .map(message => Buffer.from(message.params.deltaBase64, 'base64').toString()).join('');
  const completion = rpc('command/exec', {
    command: ['/bin/bash', '-c', 'test -t 0 && test -t 1 && printf "CODEX_DOCKER_PTY_OK\\n" && read -r line && printf "%s\\n" "$line"'],
    cwd: '/workspace', processId, tty: true, timeoutMs: 15000,
    size: { rows: 24, cols: 80 }, sandboxPolicy: { type: 'dangerFullAccess' },
  });
  // Register rejection immediately if terminal setup fails before its first output.
  completion.catch(() => {});
  await until(() => /CODEX_DOCKER_PTY_OK/.test(output()), 'PTY did not stream output', 16000);
  await rpc('command/exec/resize', { processId, size: { rows: 30, cols: 100 } });
  await rpc('command/exec/write', { processId, deltaBase64: Buffer.from('CODEX_DOCKER_STDIN_OK\n').toString('base64') });
  assert.equal((await completion).exitCode, 0);
  assert.match(output(), /CODEX_DOCKER_STDIN_OK/);

  const scope = { hostId: 'local', cwd: '/workspace', permission: 'danger-full-access' };
  const persistent = await api('/api/terminal-sessions/prepare', scope);
  assert.equal(persistent.available, true, 'Explicit full access must detect tmux for the persistent terminal');
  assert.equal(persistent.persistence, 'tmux');
  assert.ok(persistent.command.includes('new-session'));
  assert.equal((await api('/api/tmux/list', scope)).available, true);
  const sessionName = `docker-测试-${Date.now()}`;
  const { session } = await api('/api/tmux/create', { ...scope, name: sessionName });
  assert.equal(session.name, sessionName, 'tmux must preserve Unicode labels');
  try {
    assert.ok((await api('/api/tmux/list', scope)).sessions.some(entry => entry.id === session.id && entry.name === sessionName));
    const attach = await api('/api/tmux/attach', { ...scope, sessionId: session.id });
    assert.ok(attach.command.includes('attach-session'));
    const send = await rpc('command/exec', { command: ['tmux', 'send-keys', '-t', session.id, 'printf "CODEX_DOCKER_TMUX_OK\\n"', 'Enter'], cwd: '/workspace', timeoutMs: 10000, sandboxPolicy: { type: 'dangerFullAccess' } });
    assert.equal(send.exitCode, 0);
    await until(async () => /CODEX_DOCKER_TMUX_OK/.test((await api('/api/tmux/read', { ...scope, sessionId: session.id, lines: 100 })).text), 'tmux output could not be captured', 10000);
  } finally { await api('/api/tmux/delete', { ...scope, sessionId: session.id }); }
  assert.ok(!(await api('/api/tmux/list', scope)).sessions.some(entry => entry.id === session.id));
  console.log(`Docker ${phase} passed: non-root, authentication, frontend, official app-server, files, PTY, tmux and persistence.`);
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket.close();
}
