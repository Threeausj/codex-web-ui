import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createServer as createViteServer } from 'vite'
import { createServer } from '../server/app.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-vite-'))
const password = 'preview-smoke-temporary-password'
const appCookie = 'preview-app-session=fixture-only-session'
// Whitespace and Unicode make a parsed/reserialized body observably different.
const largeJson = JSON.stringify({ message: '邮件测试', body: 'x'.repeat(90_000) }, null, 2)
const observed: { path: string; cookie?: string; authorization?: string; appHeader?: string }[] = []
const vite = await createViteServer({
  configFile: false, root: directory, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'development-preview-smoke-fixtures',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) { next(); return }
        const url = new URL(req.url, 'http://fixture.invalid')
        observed.push({ path: url.pathname, cookie: req.headers.cookie, authorization: req.headers.authorization, appHeader: String(req.headers['x-app-preview'] || '') })
        res.setHeader('Content-Type', 'application/json')
        if (url.pathname === '/api/login') {
          res.setHeader('Set-Cookie', `${appCookie}; HttpOnly; Path=/; SameSite=Lax`)
          res.end(JSON.stringify({ ok: true })); return
        }
        if (url.pathname === '/api/me') {
          res.statusCode = req.headers.cookie === appCookie ? 200 : 401
          res.end(JSON.stringify({ authenticated: req.headers.cookie === appCookie, authorization: req.headers.authorization || null, appHeader: req.headers['x-app-preview'] || null })); return
        }
        if (url.pathname === '/api/echo') {
          const chunks: Buffer[] = []
          req.on('data', chunk => chunks.push(Buffer.from(chunk)))
          req.on('end', () => {
            const body = Buffer.concat(chunks)
            res.end(JSON.stringify({ exact: body.toString('utf8') === largeJson, length: body.length, authorization: req.headers.authorization || null, appHeader: req.headers['x-app-preview'] || null, authenticated: req.headers.cookie === appCookie }))
          })
          return
        }
        res.statusCode = 404; res.end(JSON.stringify({ error: 'Unknown smoke fixture route' }))
      })
    },
  }],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let application: Awaited<ReturnType<typeof createServer>> | undefined
try {
  await fs.writeFile(path.join(directory, 'index.html'), '<html><head><link href="/style.css" rel="stylesheet"><script type="module" src="/main.js"></script></head><body><p id="result">pending</p><p id="isolation">pending</p><p id="fetch">pending</p><p id="runtime">pending</p></body></html>')
  await fs.writeFile(path.join(directory, 'style.css'), 'body{background:rgb(17, 34, 51)}')
  await fs.writeFile(path.join(directory, 'module.js'), 'export const message = "VITE_INITIAL";')
  await fs.writeFile(path.join(directory, 'data.json'), '{"message":"FETCH_OK"}')
  await fs.writeFile(path.join(directory, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+UqsAAAAASUVORK5CYII=', 'base64'))
  await fs.writeFile(path.join(directory, 'main.js'), `
import { message } from '/module.js';
document.getElementById('result').textContent = message;
try { parent.document.body.dataset.escaped = 'yes'; document.getElementById('isolation').textContent = 'FAILED'; }
catch { document.getElementById('isolation').textContent = 'OPAQUE_ISOLATED'; }
fetch('/data.json').then(response => response.json()).then(value => document.getElementById('fetch').textContent = value.message);
(async () => {
  const checks = {};
  localStorage.setItem('preview-token', 'local-fixture');
  sessionStorage.setItem('preview-session', 'session-fixture');
  localStorage.propertyFixture = 'property-fixture';
  checks.storage = localStorage.getItem('preview-token') === 'local-fixture' && sessionStorage.getItem('preview-session') === 'session-fixture' && localStorage.propertyFixture === 'property-fixture';
  checks.serviceWorkerHidden = !('serviceWorker' in navigator);
  try { checks.cookieReadable = typeof document.cookie === 'string'; checks.cookieIsolated = false; }
  catch (error) { checks.cookieReadable = false; checks.cookieIsolated = error.name === 'SecurityError'; }
  const route = '/inbox'; const matcher = /^\\/api\\/(.*)$/;
  checks.preservedCode = route === '/inbox' && matcher.test('/api/mail');
  const image = new Image(); image.id = 'dynamic-preview-image';
  const imageLoaded = new Promise(resolve => { image.onload = () => resolve(image.naturalWidth === 1); image.onerror = () => resolve(false); });
  image.src = '/pixel.png'; document.body.append(image);
  checks.dynamicImage = await imageLoaded;
  await fetch('/api/login', { method: 'POST', credentials: 'include' });
  const session = await fetch('/api/me', { credentials: 'include', headers: { Authorization: 'Bearer preview-fixture', 'X-App-Preview': 'fetch-fixture' } }).then(response => response.json());
  checks.cookieAuth = session.authenticated === true;
  checks.customHeaders = session.authorization === 'Bearer preview-fixture' && session.appHeader === 'fetch-fixture';
  const echo = await fetch('/api/echo', { method: 'POST', body: ${JSON.stringify(largeJson)}, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer raw-json-fixture', 'X-App-Preview': 'raw-fixture' } }).then(response => response.json());
  checks.rawJson = echo.exact === true && echo.length === ${Buffer.byteLength(largeJson)} && echo.authenticated === true && echo.authorization === 'Bearer raw-json-fixture' && echo.appHeader === 'raw-fixture';
  checks.xhr = await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('GET', '/api/me');
    request.setRequestHeader('Authorization', 'Bearer xhr-fixture'); request.setRequestHeader('X-App-Preview', 'xhr-fixture'); request.withCredentials = true;
    request.onload = () => { const value = JSON.parse(request.responseText); resolve(request.status === 200 && value.authenticated && value.authorization === 'Bearer xhr-fixture' && value.appHeader === 'xhr-fixture'); };
    request.onerror = () => reject(new Error('XHR smoke request failed')); request.send();
  });
  document.getElementById('runtime').textContent = JSON.stringify(checks);
})().catch(error => { document.getElementById('runtime').textContent = JSON.stringify({ error: error.message }); });
`)
  await vite.listen()
  await fs.mkdir(path.join(directory, 'codex-home'), { recursive: true })
  const vitePort = (vite.httpServer!.address() as { port: number }).port
  application = await createServer({ cwd: directory, dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex-home'), password, serveStatic: false, secureCookie: false, bridgeOptions: { mode: 'spawn' } })
  await new Promise<void>(resolve => application!.server.listen(0, '127.0.0.1', resolve))
  const apiPort = (application.server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${apiPort}`
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const { csrfToken } = await login.json() as { csrfToken: string }
  const preview = await fetch(origin + '/api/dev-previews', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ port: vitePort }) })
  assert.equal(preview.status, 201)
  const { url } = await preview.json() as { url: string }
  application.app.get('/smoke', (_req, res) => res.send(`<html><body><iframe title="Smoke preview" sandbox="allow-scripts" src="${url}" style="width:100%;height:600px"></iframe></body></html>`))
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const equal = cookie.indexOf('=')
  await page.context().addCookies([{ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), url: origin, httpOnly: true, sameSite: 'Lax' }])
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.goto(origin + '/smoke')
  const frame = page.frameLocator('iframe')
  await frame.locator('#result').getByText('VITE_INITIAL', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await frame.locator('#isolation').textContent(), 'OPAQUE_ISOLATED')
  await frame.locator('#fetch').getByText('FETCH_OK', { exact: true }).waitFor({ timeout: 5000 })
  assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(17, 34, 51)')
  await frame.locator('#runtime').filter({ hasText: /^\{/ }).waitFor({ timeout: 10000 })
  const checks = JSON.parse((await frame.locator('#runtime').textContent())!)
  assert.deepEqual(checks, { storage: true, serviceWorkerHidden: true, cookieReadable: false, cookieIsolated: true, preservedCode: true, dynamicImage: true, cookieAuth: true, customHeaders: true, rawJson: true, xhr: true })
  assert.equal(observed.some(request => request.cookie?.includes(cookie)), false, 'Codex authentication cookie leaked to the app')
  assert.ok(observed.some(request => request.path === '/api/me' && request.cookie === appCookie))
  // A real Vite file watcher must deliver a WebSocket full reload through the proxy.
  await fs.writeFile(path.join(directory, 'module.js'), 'export const message = "VITE_HMR_RELOADED";')
  await frame.locator('#result').getByText('VITE_HMR_RELOADED', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.locator('body').getAttribute('data-escaped'), null)
  assert.deepEqual(failures, [])
  console.log('PASS: real Vite modules/CSS/fetch, opaque iframe isolation, scoped cookie auth, raw 90 KB JSON, custom headers/XHR, storage, dynamic images, unchanged regex/routes, and WebSocket HMR reload')
  if (process.env.PREVIEW_SKIP_CODEX_PROBE !== '1') {
    const persistent = await fetch(origin + '/api/terminal-sessions/prepare', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ hostId: 'local', cwd: directory }) })
    const feature = await persistent.json() as { available: boolean; reason?: string; sessionName?: string; error?: string }
    assert.equal(persistent.status, 200, feature.error)
    console.log(`PASS: real app-server tmux feature probe; available=${feature.available}${feature.available ? ` session=${feature.sessionName}` : ' (no installation attempted)'}`)
  }
} finally {
  await browser?.close()
  await application?.close()
  await vite.close()
  await fs.rm(directory, { recursive: true, force: true })
}
