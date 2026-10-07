import { inject, provide, reactive } from 'vue';
import type { InjectionKey } from 'vue';
type State = { tools: Set<string>; batches: Set<string>; files: Map<string, Set<string>>; reasoning: Map<string, boolean> };
const key: InjectionKey<State> = Symbol('history-disclosures');
/** Scoped to a single conversation, survives removal of offscreen DOM only. */
export function provideHistoryDisclosures() {
  const state = reactive<State>({ tools: new Set(), batches: new Set(), files: new Map(), reasoning: new Map() });
  provide(key, state); return state;
}
export function historyDisclosures() { return inject(key, null); }
