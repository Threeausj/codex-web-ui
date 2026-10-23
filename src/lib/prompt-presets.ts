import { reactive } from 'vue';
import { emptyPromptPresets, MAX_PROMPT_PRESET_CONTENT, MAX_PROMPT_PRESET_NAME, PROMPT_PRESET_SLOTS, type PromptPreset, type PromptPresetsSnapshot } from '../../shared/prompt-presets';

type Request = (path: string, options?: RequestInit) => Promise<any>;
export type PromptPresetInput = Pick<PromptPreset, 'slot' | 'name' | 'content' | 'kind'> & { expectedVersion: number };

/** Presets are Web account data, independent of the selected host or thread. */
export function usePromptPresets(request: Request, authentication: () => number | null) {
  const state = reactive({ snapshot: emptyPromptPresets(), loading: false, busy: false, loaded: false, error: '' });
  let epoch = 0;
  let fetchGeneration = 0;
  let loading: Promise<void> | undefined;
  function reset() {
    ++epoch; loading = undefined;
    state.snapshot = emptyPromptPresets();
    state.loading = state.busy = state.loaded = false; state.error = '';
  }
  function hydrate(value: PromptPresetsSnapshot) {
    if (authentication() === null || !value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.presets) || value.presets.length !== PROMPT_PRESET_SLOTS || value.presets.some((preset, index) =>
        !preset || preset.slot !== index + 1 || !Number.isSafeInteger(preset.version) || preset.version < 0 ||
        typeof preset.name !== 'string' || preset.name.length > MAX_PROMPT_PRESET_NAME ||
        typeof preset.content !== 'string' || preset.content.length > MAX_PROMPT_PRESET_CONTENT ||
        !['prompt', 'command'].includes(preset.kind)) ||
      value.presets.reduce((sum, preset) => sum + preset.version, 0) !== value.revision) return false;
    // HTTP requests may finish after a newer WebSocket snapshot has arrived.
    if (value.revision >= state.snapshot.revision) state.snapshot = structuredClone(value);
    state.loaded = true;
    return true;
  }
  function refresh(force = false) {
    if (authentication() === null) return Promise.resolve();
    if (loading && !force) return loading;
    const currentEpoch = epoch, auth = authentication();
    const generation = ++fetchGeneration;
    const current = () => currentEpoch === epoch && auth === authentication() && generation === fetchGeneration;
    state.loading = true; state.error = '';
    const operation = (async () => {
      try {
        const response = await request('/prompt-presets', { signal: AbortSignal.timeout(15000) });
        if (current() && !hydrate(response)) throw new Error('预设数据不完整，请刷新后重试');
      }
      catch (cause: any) {
        if (current()) state.error = cause.name === 'TimeoutError' ? '读取预设超时，请检查网络后重试' :
          cause.message || '读取提示词预设失败，请重试';
      }
      finally { if (current()) { state.loading = false; loading = undefined; } }
    })();
    loading = operation;
    return operation;
  }
  async function mutate(slot: number, method: 'PUT' | 'DELETE', body: unknown) {
    if (authentication() === null) throw new Error('请先登录');
    if (state.busy) throw new Error('正在保存预设，请稍候');
    const currentEpoch = epoch, auth = authentication();
    const current = () => currentEpoch === epoch && auth === authentication();
    state.busy = true; state.error = '';
    try {
      const response = await request(`/prompt-presets/${slot}`, { method, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (!current()) throw new Error('登录状态已变化，请重新检查预设');
      if (!hydrate(response)) throw new Error('预设数据不完整，请刷新后确认保存结果');
    } catch (cause: any) {
      if (current()) {
        const message = cause.name === 'TimeoutError' ? '保存请求超时，服务端可能已保存；请刷新预设确认后再修改' :
          cause.message || '保存提示词预设失败，请重试';
        if (cause.status === 409 || cause.code === 'PRESET_CONFLICT') await refresh(true);
        if (current()) state.error = message;
      }
      throw cause;
    } finally { if (current()) state.busy = false; }
  }
  return { state, hydrate, reset, refresh,
    save(input: PromptPresetInput) { const { slot, ...body } = input; return mutate(slot, 'PUT', body); },
    remove(input: Pick<PromptPresetInput, 'slot' | 'expectedVersion'>) { return mutate(input.slot, 'DELETE', { expectedVersion: input.expectedVersion }); },
  };
}

/** Insertion never overwrites a selection, an existing draft, or attachments. */
export function insertPromptPreset(draft: string, content: string, position = draft.length) {
  const at = Math.max(0, Math.min(Number.isFinite(position) ? position : draft.length, draft.length));
  const before = draft.slice(0, at), after = draft.slice(at);
  const prefix = before && !/\s$/.test(before) && !/^\s/.test(content) ? '\n\n' : '';
  const suffix = after && !/^\s/.test(after) && !/\s$/.test(content) ? '\n\n' : '';
  return { text: before + prefix + content + suffix + after, position: before.length + prefix.length + content.length };
}
