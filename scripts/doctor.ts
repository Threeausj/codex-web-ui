import 'dotenv/config';
import { Bridge } from '../server/bridge.js';
import path from 'node:path';
import os from 'node:os';

// Read-only by default. --turn explicitly performs one tiny inference and archives
// its diagnostic thread; all traffic still uses the official app-server protocol.
const bridge = new Bridge({ id: 'local', name: '本机', kind: 'local' }, {
  codexBin: process.env.CODEX_BIN || 'codex',
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  cwd: process.cwd(),
  mode: process.env.CODEX_CONNECTION_MODE === 'proxy' ? 'proxy' : 'spawn',
  socketPath: process.env.CODEX_SOCKET_PATH,
});
try {
  await bridge.connect();
  const config = await bridge.request('config/read', { cwd: process.cwd() }) as any;
  const models = await bridge.request('model/list', { limit: 100 }) as any;
  const threads = await bridge.request('thread/list', { limit: 10, cwd: process.cwd() }) as any;
  const files = await bridge.request('fs/readDirectory', { path: process.cwd() }) as any;
  console.log(JSON.stringify({ connected: true, mode: bridge.mode, models: models.data.length, threads: threads.data.length, projectEntries: files.entries.length, configurationLoaded: !!config.config }, null, 2));
  if (process.argv.includes('--turn')) {
    const model = config.config.model ?? models.data.find((model: any) => model.isDefault)?.model;
    const result = await bridge.request('thread/start', { cwd: process.cwd(), model, sandbox: 'read-only', approvalPolicy: 'on-request' }) as any;
    const threadId = result.thread.id;
    try {
      await bridge.request('thread/name/set', { threadId, name: 'Codex Web · 连接验证' });
      await bridge.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: '这是 app-server 客户端连通性验证。不要调用任何工具，不要读取文件或运行命令。请只回复 CODEX_WEB_OK。', text_elements: [] }],
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'on-request',
      });
      const deadline = Date.now() + 60000;
      let final: any;
      while (Date.now() < deadline) {
        const page = await bridge.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }) as any;
        const turn = page.data[0];
        if (turn && turn.status !== 'inProgress') { final = turn; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!final) throw new Error('验证 turn 在 60 秒内未完成');
      if (final.status !== 'completed') throw new Error(final.error?.message ?? `Turn ${final.status}`);
      const text = final.items.filter((item: any) => item.type === 'agentMessage').map((item: any) => item.text).join('\n');
      if (!text.includes('CODEX_WEB_OK')) throw new Error('模型没有返回预期的验证标记');
      console.log('真实模型 turn 通过：CODEX_WEB_OK');
      // A second process sees the persisted conversation through the same data directory.
      const reader = new Bridge({ id: 'reader', name: '同步验证', kind: 'local' }, bridge.options);
      try {
        const read = await reader.request('thread/read', { threadId, includeTurns: true }) as any;
        if (read.thread.id !== threadId || !read.thread.turns.length) throw new Error('持久化会话读取失败');
        console.log('共享 Codex 数据目录的跨进程历史读取通过');
      } finally { reader.close(); }
    } finally { await bridge.request('thread/archive', { threadId }).catch(() => {}); }
  }
} finally { bridge.close(); }
