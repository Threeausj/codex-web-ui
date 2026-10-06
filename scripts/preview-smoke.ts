import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createServer as createViteServer } from 'vite'
import { createServer } from '../server/app.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-vite-'))
const password = 'preview-smoke-temporary-password'
const vite = await createViteServer({ configFile: false, root: directory, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let application: Awaited<ReturnType<typeof createServer>> | undefined
try {
  await fs.writeFile(path.join(directory, 'index.html'), '<html><head><link href="/style.css" rel="stylesheet"><script type="module" src="/main.js"></script></head><body><p id="result">pending</p><p id="isolation">pending</p><p id="fetch">pending</p></body></html>')
  await fs.writeFile(path.join(directory, 'style.css'), 'body{background:rgb(17, 34, 51)}')
  await fs.writeFile(path.join(directory, 'module.js'), 'export const message = "VITE_INITIAL";')
  await fs.writeFile(path.join(directory, 'data.json'), '{"message":"FETCH_OK"}')
  await fs.writeFile(path.join(directory, 'main.js'), 'import { message } from "/module.js"; document.getElementById("result").textContent=message; try{parent.document.body.dataset.escaped="yes";document.getElementById("isolation").textContent="FAILED"}catch{document.getElementById("isolation").textContent="OPAQUE_ISOLATED"}fetch("/data.json").then(r=>r.json()).then(v=>document.getElementById("fetch").textContent=v.message);')
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
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.goto(origin + '/smoke')
  const frame = page.frameLocator('iframe')
  await frame.locator('#result').getByText('VITE_INITIAL', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await frame.locator('#isolation').textContent(), 'OPAQUE_ISOLATED')
  await frame.locator('#fetch').getByText('FETCH_OK', { exact: true }).waitFor({ timeout: 5000 })
  assert.equal(await frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(17, 34, 51)')
  // A real Vite file watcher must deliver a WebSocket full reload through the proxy.
  await fs.writeFile(path.join(directory, 'module.js'), 'export const message = "VITE_HMR_RELOADED";')
  await frame.locator('#result').getByText('VITE_HMR_RELOADED', { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(await page.locator('body').getAttribute('data-escaped'), null)
  assert.deepEqual(failures, [])
  console.log('PASS: real Vite root modules/CSS/fetch, opaque iframe isolation, mobile viewport, and WebSocket HMR reload')
  const persistent = await fetch(origin + '/api/terminal-sessions/prepare', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ hostId: 'local', cwd: directory }) })
  const feature = await persistent.json() as { available: boolean; reason?: string; sessionName?: string; error?: string }
  assert.equal(persistent.status, 200, feature.error)
  console.log(`PASS: real app-server tmux feature probe; available=${feature.available}${feature.available ? ` session=${feature.sessionName}` : ' (no installation attempted)'}`)
} finally {
  await browser?.close()
  await application?.close()
  await vite.close()
  await fs.rm(directory, { recursive: true, force: true })
}
