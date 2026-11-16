import { isMarkdownCodeAt } from './markdown-editing';
import { validAppId, validPluginId, type InstalledPlugin } from '../../shared/plugin-mentions';

/** Plugin skills remain available through '/', while '@' selects their bundle. */
export function mentionedPlugins(inventory: InstalledPlugin[], skills: any[]): InstalledPlugin[] {
  const plugins = new Map(inventory.filter(plugin => validPluginId(plugin.id)).map(plugin => [plugin.id, plugin]));
  for (const skill of skills) {
    if (!validPluginId(skill.pluginId) || plugins.has(skill.pluginId)) continue;
    const name = skill.pluginId.split('@')[0];
    plugins.set(skill.pluginId, { id: skill.pluginId, name, displayName: skill.interface?.displayName || name,
      description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '', enabled: skill.enabled !== false });
  }
  return [...plugins.values()];
}

/** Only explicit mentions in the user's prompt activate integrations. Quoted
 * context and code examples must not activate plugins or apps incidentally. */
export function integrationInputs(text: string): { type: 'mention'; name: string; path: string }[] {
  const result: { type: 'mention'; name: string; path: string }[] = [], seen = new Set<string>();
  const links = /\[@([^\]\r\n]{1,160})\]\((plugin|app):\/\/([^\s()]+)\)/g;
  const visible = text.replace(/(`+)[\s\S]*?\1/g, code => ' '.repeat(code.length));
  for (const match of visible.matchAll(links)) {
    const [, name, kind, id] = match;
    if (!(kind === 'plugin' ? validPluginId(id) : validAppId(id))) continue;
    const line = text.slice(text.lastIndexOf('\n', match.index! - 1) + 1, match.index!);
    if (line.trimStart().startsWith('>') || isMarkdownCodeAt(text, match.index!)) continue;
    const path = `${kind}://${id}`;
    if (!seen.has(path)) { result.push({ type: 'mention', name: name!, path }); seen.add(path); }
  }
  return result;
}
