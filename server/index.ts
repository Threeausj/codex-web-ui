import 'dotenv/config'
import { createServer } from './app.js'
import { isLoopback } from './auth.js'

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535')
if (!process.env.CODEX_WEB_PASSWORD && !isLoopback(host)) throw new Error('Public binding requires an explicit CODEX_WEB_PASSWORD of at least 12 characters')
if (!isLoopback(host) && !process.env.PUBLIC_ORIGIN) throw new Error('Public binding requires PUBLIC_ORIGIN for WebSocket and CSRF validation')
if (process.env.CODEX_CONNECTION_MODE && !['spawn', 'proxy'].includes(process.env.CODEX_CONNECTION_MODE)) throw new Error('CODEX_CONNECTION_MODE must be spawn or proxy')
const application = await createServer({ port })
application.server.listen(port, host, () => console.log(`Codex Web: http://${host.includes(':') ? `[${host}]` : host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void application.close().finally(() => process.exit(0)) })
