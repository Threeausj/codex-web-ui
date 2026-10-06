import type { CollaborationMode } from '../../shared/protocol/CollaborationMode';

export function nativeCollaborationMode(mode: 'default' | 'plan', model: string, effort: string): CollaborationMode {
  if (!model.trim()) throw new Error('模型配置尚未加载，请稍候');
  return { mode, settings: { model, reasoning_effort: (effort || null) as any, developer_instructions: null } };
}

export function goalMethodSupported(error: unknown): boolean {
  const value = error as { code?: number; message?: string };
  // Probe a nonexistent thread: a recognized method reaches thread lookup.
  return value?.code === -32600 && /thread not found/i.test(value.message || '');
}

export function skillInventory(result: any, cwd: string): any[] {
  const paths = new Set<string>();
  return (result?.data || []).filter((entry: any) => entry.cwd === cwd)
    .flatMap((entry: any) => entry.skills || [])
    .filter((skill: any) => {
      if (typeof skill.name !== 'string' || !skill.name || typeof skill.path !== 'string' || !skill.path.startsWith('/') || paths.has(skill.path)) return false;
      paths.add(skill.path);
      return true;
    });
}

export function skillMention(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\$${escaped}(?![\\w-])`).test(text);
}
