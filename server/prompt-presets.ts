import type { Express, NextFunction, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './storage.js';
import {
  emptyPromptPresets, MAX_PROMPT_PRESET_COMMAND, MAX_PROMPT_PRESET_CONTENT,
  MAX_PROMPT_PRESET_NAME, PROMPT_PRESET_SLOTS,
  type PromptPreset, type PromptPresetsSnapshot,
} from '../shared/prompt-presets.js';

export const MAX_PROMPT_PRESETS_BYTES = 1024 * 1024;
const slotSchema = z.number().int().min(1).max(PROMPT_PRESET_SLOTS);
const revisionSchema = z.number().int().nonnegative().safe();
const nameSchema = z.string().trim().min(1).max(MAX_PROMPT_PRESET_NAME)
  .refine(value => !/[\x00-\x1f\x7f]/.test(value), '预设名称不能包含控制字符');
const contentSchema = z.string().min(1).max(MAX_PROMPT_PRESET_CONTENT)
  .refine(value => !!value.trim() && !value.includes('\0'), '请输入预设内容');
const fieldsSchema = z.object({ name: nameSchema, content: contentSchema, kind: z.enum(['prompt', 'command']) }).strict();
const validCommand = (value: { kind: string; content: string }) => value.kind !== 'command' ||
  value.content.length <= MAX_PROMPT_PRESET_COMMAND && /^\/[a-z][a-z0-9-]*(?:[ \t][^\r\n]*)?$/i.test(value.content);
export const promptPresetInput = fieldsSchema.extend({ expectedVersion: revisionSchema }).strict()
  .refine(validCommand, '命令预设需要是以 / 开头的单行命令，最多 2000 个字符');
const removeSchema = z.object({ expectedVersion: revisionSchema }).strict();
const presetSchema = z.object({
  slot: slotSchema, name: z.string(), content: z.string(), kind: z.enum(['prompt', 'command']), version: revisionSchema,
}).strict().superRefine((value, context) => {
  const empty = value.name === '' && value.content === '' && value.kind === 'prompt';
  if (!empty && (!fieldsSchema.safeParse(valueFields(value)).success || !validCommand(value)))
    context.addIssue({ code: 'custom', message: 'Invalid persisted prompt preset' });
  if (value.version === 0 && !empty)
    context.addIssue({ code: 'custom', message: 'Unversioned prompt preset' });
});
const documentSchema = z.object({
  version: z.literal(1), revision: revisionSchema, presets: z.array(presetSchema).length(PROMPT_PRESET_SLOTS),
}).strict().superRefine((value, context) => {
  if (value.presets.some((preset, index) => preset.slot !== index + 1) ||
      value.presets.reduce((total, preset) => total + preset.version, 0) !== value.revision)
    context.addIssue({ code: 'custom', message: 'Invalid prompt preset slots or revision' });
});
function valueFields(value: PromptPreset) { return { name: value.name, content: value.content, kind: value.kind }; }
const conflict = () => Object.assign(new Error('预设已在其他设备修改，请刷新后重试'), { status: 409, code: 'PRESET_CONFLICT' });

/** Web-owned presets never read CLI configuration or start a Codex process. */
export class PromptPresets {
  private value = emptyPromptPresets();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: PromptPresetsSnapshot) => void>();
  constructor(readonly file: string) {}

  async init() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROMPT_PRESETS_BYTES)
        throw new Error('Invalid prompt preset journal');
      const document = documentSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
      this.value = { presets: document.presets, revision: document.revision };
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Unable to read prompt-presets.json; restore the saved prompt presets before restarting', { cause: error });
    }
  }

  get(): PromptPresetsSnapshot { return structuredClone(this.value); }

  subscribe(listener: (snapshot: PromptPresetsSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  update(slot: unknown, input: unknown): Promise<PromptPresetsSnapshot> {
    const validatedSlot = slotSchema.parse(slot), fields = promptPresetInput.parse(input);
    return this.mutate(validatedSlot, fields.expectedVersion, () => ({ name: fields.name, content: fields.content, kind: fields.kind }));
  }

  remove(slot: unknown, input: unknown): Promise<PromptPresetsSnapshot> {
    const validatedSlot = slotSchema.parse(slot), fields = removeSchema.parse(input);
    return this.mutate(validatedSlot, fields.expectedVersion, () => ({ name: '', content: '', kind: 'prompt' }));
  }

  private mutate(slot: number, expectedVersion: number, fields: () => Pick<PromptPreset, 'name' | 'content' | 'kind'>) {
    const operation = this.queue.then(async () => {
      const current = this.value.presets[slot - 1]!;
      if (current.version !== expectedVersion) throw conflict();
      if (this.value.revision === Number.MAX_SAFE_INTEGER) throw Object.assign(new Error('预设版本已达到上限'), { status: 409 });
      const next = this.get();
      next.presets[slot - 1] = { slot, ...fields(), version: current.version + 1 };
      ++next.revision;
      const document = { version: 1, ...next };
      if (Buffer.byteLength(JSON.stringify(document, null, 2) + '\n') > MAX_PROMPT_PRESETS_BYTES)
        throw Object.assign(new Error('预设内容超过容量上限'), { status: 413 });
      await writePrivateJson(this.file, document);
      this.value = next;
      for (const listener of this.listeners) {
        try { listener(this.get()); } catch { /* A failed browser listener cannot undo a committed preset. */ }
      }
      return this.get();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** The application has already installed authentication and CSRF middleware. */
export async function registerPromptPresets(app: Express, dataDir: string) {
  const presets = new PromptPresets(path.join(dataDir, 'prompt-presets.json'));
  await presets.init();
  const reject = (error: unknown, res: Response, next: NextFunction) => {
    if ((error as { code?: string })?.code === 'PRESET_CONFLICT') res.status(409).json({ error: (error as Error).message, code: 'PRESET_CONFLICT' });
    else next(error);
  };
  const routeSlot = z.string().regex(/^(?:[1-9]|10)$/).transform(Number);
  app.get('/api/prompt-presets', (_req, res) => { res.json(presets.get()); });
  app.put('/api/prompt-presets/:slot', (req, res, next) => {
    void (async () => res.json(await presets.update(routeSlot.parse(req.params.slot), req.body)))().catch(error => reject(error, res, next));
  });
  app.delete('/api/prompt-presets/:slot', (req, res, next) => {
    void (async () => res.json(await presets.remove(routeSlot.parse(req.params.slot), req.body)))().catch(error => reject(error, res, next));
  });
  return presets;
}
