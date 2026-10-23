export const PROMPT_PRESET_SLOTS = 10;
export const MAX_PROMPT_PRESET_NAME = 80;
export const MAX_PROMPT_PRESET_CONTENT = 16000;
export const MAX_PROMPT_PRESET_COMMAND = 2000;

export type PromptPreset = {
  slot: number;
  name: string;
  content: string;
  kind: 'prompt' | 'command';
  /** A cleared slot retains its version so stale devices cannot resurrect it. */
  version: number;
};
export type PromptPresetsSnapshot = { presets: PromptPreset[]; revision: number };
export type PromptPresetInput = Pick<PromptPreset, 'name' | 'content' | 'kind'> & { expectedVersion: number };

export function emptyPromptPresets(): PromptPresetsSnapshot {
  return {
    presets: Array.from({ length: PROMPT_PRESET_SLOTS }, (_, index) => ({
      slot: index + 1, name: '', content: '', kind: 'prompt', version: 0,
    })),
    revision: 0,
  };
}
