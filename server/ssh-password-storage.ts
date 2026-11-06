import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'

const encoded = (bytes?: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value =>
  Buffer.from(value, 'base64url').toString('base64url') === value && (bytes === undefined || Buffer.from(value, 'base64url').length === bytes))
const recordSchema = z.object({ version: z.literal(1), nonce: encoded(12), tag: encoded(16), ciphertext: encoded().max(8192) }).strict()
export type EncryptedSshPassword = z.infer<typeof recordSchema>
const unavailable = () => new Error('无法读取 SSH 密码，请检查服务端凭据文件并重新保存连接。')

/** The journal holds authenticated ciphertext; its separate key stays server-side.
 * Neither representation is ever assigned to a public Host object. */
export class SshPasswordStorage {
  readonly keyFile: string
  private key?: Promise<Buffer>
  constructor(dataDir: string) { this.keyFile = path.join(dataDir, 'ssh-password.key') }

  private async readKey(create: boolean) {
    try {
      if (create) {
        const candidate = randomBytes(32)
        try {
          const file = await fs.open(this.keyFile, 'wx', 0o600)
          try { await file.writeFile(candidate); await file.sync() } finally { await file.close() }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const handle = await fs.open(this.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== 32 || stat.nlink !== 1) throw unavailable()
        await handle.chmod(0o600)
        const key = await handle.readFile()
        if (key.length !== 32) throw unavailable()
        return key
      } finally { await handle.close() }
    } catch { throw unavailable() }
  }
  private getKey(create: boolean) {
    return this.key ||= this.readKey(create).catch(error => { this.key = undefined; throw error })
  }
  async encrypt(password: string, scope: string): Promise<EncryptedSshPassword> {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await this.getKey(true), nonce)
    cipher.setAAD(Buffer.from(scope))
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    return { version: 1, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
  }
  async decrypt(value: unknown, scope: string): Promise<string> {
    try {
      const record = recordSchema.parse(value)
      const decipher = createDecipheriv('aes-256-gcm', await this.getKey(false), Buffer.from(record.nonce, 'base64url'))
      decipher.setAAD(Buffer.from(scope))
      decipher.setAuthTag(Buffer.from(record.tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    } catch { throw unavailable() }
  }
  parse(value: unknown): EncryptedSshPassword {
    try { return recordSchema.parse(value) } catch { throw unavailable() }
  }
}
