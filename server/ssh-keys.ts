import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import multer from 'multer'
import type { Express } from 'express'
import type { Storage } from './storage.js'

const run = promisify(execFile)
export const SSH_KEY_MAX_BYTES = 64 * 1024
const keyIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status })

export class SshKeys {
  readonly directory: string
  constructor(dataDir: string, private readonly storage: Storage) {
    this.directory = path.resolve(dataDir, 'ssh-keys')
  }

  async upload(buffer: Buffer) {
    if (!buffer.length || buffer.length > SSH_KEY_MAX_BYTES) throw failure('私钥文件须为 1–64 KB。')
    const key = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() + '\n'
    if (!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\n/.test(key)) {
      throw failure('请选择 OpenSSH 或 PEM 格式的 SSH 私钥，不能使用公钥文件。')
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await fs.lstat(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('SSH 密钥目录不可用。', 500)
    await fs.chmod(this.directory, 0o700)
    const id = randomUUID()
    const identityFile = path.join(this.directory, `${id}.key`)
    await fs.writeFile(identityFile, key, { mode: 0o600, flag: 'wx' })
    try {
      await fs.chmod(identityFile, 0o600)
      await run('ssh-keygen', ['-y', '-f', identityFile, '-P', ''], {
        timeout: 5000,
        maxBuffer: 8192,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      })
    } catch (error) {
      await fs.rm(identityFile, { force: true })
      const detail = error as { code?: string; stderr?: string }
      if (detail.code === 'ENOENT') throw failure('服务端未安装 ssh-keygen，无法验证私钥。', 503)
      if (/passphrase|encrypted/i.test(detail.stderr || '') || key.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
        throw failure('此私钥需要口令。请使用无口令私钥，或通过已有的 SSH 配置和代理身份连接。')
      }
      throw failure('私钥文件无效，请上传完整的 OpenSSH 或 PEM 私钥。')
    }
    return { id, identityFile }
  }

  async remove(id: string) {
    if (!keyIdPattern.test(id)) throw failure('密钥标识无效。')
    const identityFile = path.join(this.directory, `${id}.key`)
    if (this.storage.hosts.some(host => host.identityFile === identityFile)) {
      throw failure('此密钥仍被 SSH 连接使用。', 409)
    }
    await fs.rm(identityFile, { force: true })
  }

  async removeUnused(identityFile?: string) {
    if (!identityFile || path.dirname(identityFile) !== this.directory) return
    const id = path.basename(identityFile, '.key')
    if (!keyIdPattern.test(id) || identityFile !== path.join(this.directory, `${id}.key`)) return
    if (!this.storage.hosts.some(host => host.identityFile === identityFile)) await this.remove(id)
  }
}

/** Register after authentication and CSRF middleware; private bytes never enter API responses. */
export function registerSshKeys(app: Express, keys: SshKeys) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: SSH_KEY_MAX_BYTES, fields: 0, parts: 1 } })
  app.post('/api/ssh-keys', upload.single('key'), (req, res, next) => {
    if (!req.file) { next(failure('请选择要上传的 SSH 私钥。')); return }
    void keys.upload(req.file.buffer).then(key => res.status(201).json(key)).catch(next)
  })
  app.delete('/api/ssh-keys/:id', (req, res, next) => {
    void keys.remove(String(req.params.id)).then(() => res.json({ ok: true })).catch(next)
  })
}
