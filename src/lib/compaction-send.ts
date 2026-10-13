import { watch } from 'vue';

type CompactionWait = { valid: boolean; compacting: boolean; dedicatedTurnActive: boolean; failed: boolean };

/** One in-memory submission waits for compression; it never retries an RPC.
 * Synchronous cancellation catches A → B → A navigation, while readiness is
 * rechecked in a microtask so a finishing turn can apply its final state first.
 */
export function waitForCompaction(read: () => CompactionWait, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, checking = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe?.(); clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const inspect = (status: CompactionWait) => {
      if (!status.valid) { finish(new Error('连接或会话已变化，待发送消息已取消；草稿已保留。')); return; }
      if (status.failed) { finish(new Error('上下文压缩未成功，消息尚未发送；草稿已保留。')); return; }
      if (status.compacting || status.dedicatedTurnActive || checking || settled) return;
      checking = true;
      queueMicrotask(() => {
        checking = false;
        if (settled) return;
        const current = read();
        if (!current.valid || current.failed) { inspect(current); return; }
        if (!current.compacting && !current.dedicatedTurnActive) finish();
      });
    };
    unsubscribe = watch(read, inspect, { immediate: true, flush: 'sync' });
    if (settled) unsubscribe();
    else timer = setTimeout(() => finish(new Error('等待上下文压缩超时，消息尚未发送；草稿已保留。')), timeoutMs);
  });
}
