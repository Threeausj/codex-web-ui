import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { Express } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Host } from './types.js';
import type { BridgeOptions } from './bridge.js';
import { sharedSshPool } from './ssh-pool.js';
import { hostPythonInput, sshPythonArgs, shellQuote } from './ssh.js';
import { isAbsoluteHostPath, normalizeHostPath, joinHostPath } from '../shared/host-path.js';
import { validFileEntryName, type FileEntryChange } from '../shared/file-entries.js';
import { fileTransferScript } from './file-transfer.js';
import { fileEntryFailures } from './file-entries.js';
export const MAX_WORKSPACE_UPLOAD = 100 * 1024 * 1024;

/** Stream bytes on a separate trusted SSH channel. Neither Base64 file contents
 * nor model tool calls are involved; the original daemon remains untouched. */
export async function writeHostFileUpload(host: Host, file: string, source: string, options: BridgeOptions = {}) {
  const pin = host.kind === 'ssh' ? await options.resolveSshHostKeyPin?.(host) ?? options.sshHostKeyPin : undefined;
  const lease = host.kind === 'ssh' ? await (options.sshPool || sharedSshPool).acquire(host, pin) : undefined;
  try {
    const args = host.kind === 'ssh' ? sshPythonArgs(host, pin, lease?.control) : ['-c', source];
    if (host.kind === 'ssh' && host.platform !== 'windows')
      args[args.length - 1] = `exec python3 -c ${shellQuote(source)}`;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(host.kind === 'ssh' ? 'ssh' : 'python3', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const stream = createReadStream(file); let stdout = '', stderr = '', settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); stream.destroy(); error ? reject(error) : resolve(stdout); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); finish(new Error('文件上传超时，请刷新目标目录核对结果后重试。')); }, 110000);
      timer.unref();
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 32768) { child.kill('SIGKILL'); finish(new Error('上传返回结果超出限制')); } });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
      child.stdin.on('error', () => { stream.destroy(); });
      stream.on('error', () => { child.kill('SIGKILL'); finish(new Error('无法读取临时上传文件')); });
      child.on('error', () => finish(new Error('无法启动文件上传连接')));
      child.on('close', code => finish(code === 0 ? undefined : new Error(/host key|identification has changed/i.test(stderr) ? '请核对 SSH 主机指纹后重试。' : '文件上传连接中断，请刷新目标目录核对结果。')));
      if (host.kind === 'ssh' && host.platform === 'windows') child.stdin.write(hostPythonInput(host, source));
      stream.pipe(child.stdin);
    });
  } finally { lease?.release(); }
}

type Dependencies = { getHost(id: string): Host | undefined; bridgeOptions?: BridgeOptions; write?: typeof writeHostFileUpload };
export function registerWorkspaceUploads(app: Express, dependencies: Dependencies) {
  const input = z.object({ directory: z.string().min(1).max(4096).refine(isAbsoluteHostPath).transform(normalizeHostPath), name: z.string().refine(validFileEntryName) }).strict();
  app.post('/api/hosts/:id/file-entries/upload', (req, res, next) => {
    void (async () => {
      const hostId = String(req.params.id), host = dependencies.getHost(hostId);
      if (!host) { res.status(404).json({ error: '主机不存在或已停用' }); return; }
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workspace-upload-'));
      try {
        await fs.chmod(directory, 0o700);
        const receive = multer({ storage: multer.diskStorage({ destination: directory, filename: (_req, _file, done) => done(null, 'bytes') }),
          limits: { fileSize: MAX_WORKSPACE_UPLOAD, files: 1, fields: 2, fieldSize: 8192 } }).single('file');
        try { await new Promise<void>((resolve, reject) => receive(req, res, error => error ? reject(error) : resolve())); }
        catch (error) {
          if (!(error instanceof multer.MulterError)) throw error;
          res.status(413).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '单个文件最多上传 100 MB。' : '上传格式或数量不正确，请每次提交一个文件。' });return;
        }
        const fields = input.parse(req.body);
        if (!req.file) { res.status(400).json({ error: '请选择上传文件' }); return; }
        if (dependencies.getHost(hostId) !== host) { res.status(409).json({ error: '主机配置已变化，请重新上传' }); return; }
        const digest = createHash('sha256'); for await (const chunk of createReadStream(req.file.path)) digest.update(chunk);
        const source = fileTransferScript({ ...fields, operation: 'upload', size: req.file.size, sha256: digest.digest('hex') });
        const result = JSON.parse(await (dependencies.write || writeHostFileUpload)(host, req.file.path, source, dependencies.bridgeOptions));
        if (result.ok !== true) { const failure = fileEntryFailures[result.code] || fileEntryFailures.FAILED!; res.status(failure.status).json({ error: failure.error, code: result.code }); return; }
        res.status(201).json({ hostId, directory: fields.directory, operation: 'upload', path: joinHostPath(fields.directory, fields.name), isDirectory: false } satisfies FileEntryChange);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    })().catch(next);
  });
}
