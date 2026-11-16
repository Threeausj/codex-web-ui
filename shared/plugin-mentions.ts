export type InstalledPlugin = {
  id: string; name: string; displayName: string; description: string;
  enabled: boolean; icon?: string; brandColor?: string;
};
export type PluginInventory = { plugins: InstalledPlugin[]; supported: boolean; reason?: string };
export const validPluginId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export const validAppId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
export function integrationMention(name: string, path: string) {
  return `[@${name.replace(/[\\[\]\r\n]/g, ' ').trim()}](${path})`;
}
