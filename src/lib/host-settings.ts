import { reactive } from 'vue';

type Http = (url: string, options?: RequestInit, reportError?: boolean) => Promise<any>;
/** A settings host is deliberately independent of the selected conversation. */
export function useHostSettings(main: any, http: Http, identity: () => any, onConfigurationChanged: (hostId: string) => void) {
  const entries = new Map<string, { state: any; api: any }>();
  const reads = new Map<string, Promise<any>>();
  const revisions = new Map<string, number>();
  let authentication = identity().authenticationGeneration;
  function session() {
    const current = identity().authenticationGeneration;
    if (current !== authentication) { resetHostSettings(); authentication = current; }
    return current;
  }
  const path = (id: string) => `/hosts/${encodeURIComponent(id)}`;
  const selected = (id: string, generation: number) => generation === identity().authenticationGeneration && main.authenticated && main.hosts.some((host: any) => host.id === id);
  const revision = (id: string) => revisions.get(id) || 0;
  const current = (id: string, generation: number, version: number) => selected(id, generation) && version === revision(id);
  function assertCurrent(id: string, generation: number, version: number) {
    if (!selected(id, generation)) throw new Error('登录状态或主机已变化，请重新读取设置');
    if (version !== revision(id)) throw new Error('Codex 连接或配置已变化，请重新读取设置');
  }
  function invalidateHostSettings(hostId: string) {
    revisions.set(hostId, revision(hostId) + 1);
    delete main.runtimeInformation[hostId];
    // Keep the reactive object used by the settings page, but discard every
    // coalesced read from its previous engine/configuration.
    for (const key of reads.keys()) if (JSON.parse(key)[1] === hostId) reads.delete(key);
    const view = entries.get(hostId)?.state;
    if (view) Object.assign(view, { loading: false, config: null, requirements: null, engineId: null });
  }
  function resetHostSettings() {
    for (const entry of entries.values()) {
      Object.assign(entry.state, { loading: false, config: null, account: null, requirements: null, models: [], skills: [], apps: [], mcpServers: [], integrationErrors: [], nativePermissionProfiles: [], connected: false });
    }
    entries.clear(); reads.clear(); revisions.clear(); main.runtimeInformation = {}; main.runtimeReconnectingHostId = '';
  }
  async function settingsRpc(hostId: string, method: string, params?: any) {
    const generation = session();
    const changesConfiguration = ['config/batchWrite', 'skills/config/write', 'config/mcpServer/reload'].includes(method);
    if (changesConfiguration) invalidateHostSettings(hostId);
    const version = revision(hostId);
    const result = await http(`${path(hostId)}/settings/rpc`, { method: 'POST', body: JSON.stringify({ method, params }) }, false);
    assertCurrent(hostId, generation, version);
    if (changesConfiguration) onConfigurationChanged(hostId);
    return result;
  }
  function hostSettings(hostId: string) {
    session();
    let entry = entries.get(hostId);
    if (entry) return entry;
    const view = reactive({
      hostId, config: null as any, requirements: null as any, models: [] as any[], account: null as any,
      nativePermissionProfiles: [] as any[], skills: [] as any[], apps: [] as any[], mcpServers: [] as any[],
      integrationErrors: [] as any[], connected: hostId === main.hostId && main.connected, runtimePaused: false,
      switchingHost: false, loading: false, model: '', engineId: null as any,
      get preferences() { return main.preferences; }, get hosts() { return main.hosts; },
      get projectPath() { return hostId === main.hostId ? main.projectPath : main.hosts.find((host: any) => host.id === hostId)?.cwd || ''; },
    });
    const readConfig = async () => {
      const generation = session();
      const version = revision(hostId), cwd = view.projectPath;
      const valid = () => current(hostId, generation, version) && entries.get(hostId)?.state === view && cwd === view.projectPath;
      const key = JSON.stringify([generation, hostId, version, 'config', cwd]);
      if (reads.has(key)) return reads.get(key);
      const operation = (async () => {
        view.loading = true;
        try {
          const information = await refreshRuntimeInformation(hostId);
          if (!valid() || !information.runtime?.connected || information.runtime?.paused) return;
          const results = await Promise.allSettled([
            settingsRpc(hostId, 'config/read', { includeLayers: true, cwd: cwd || undefined }),
            settingsRpc(hostId, 'configRequirements/read'),
            settingsRpc(hostId, 'account/read', { refreshToken: false }),
            settingsRpc(hostId, 'permissionProfile/list', { cwd: cwd || undefined }),
          ]);
          if (!valid()) return;
          if (results[0].status === 'rejected') throw results[0].reason;
          view.config = results[0].value;
          view.model = view.config?.config?.model || information.config?.model || '';
          for (const [index, field, nested] of [[1, 'requirements', 'requirements'], [2, 'account', 'account'], [3, 'nativePermissionProfiles', 'data']] as const) {
            const result = results[index];
            if (result?.status === 'fulfilled') (view as any)[field] = result.value?.[nested] ?? null;
            else if (index === 1 && result?.status === 'rejected' && result.reason?.code !== -32601) throw result.reason;
          }
        } finally { if (valid()) view.loading = false; }
      })().finally(() => { if (reads.get(key) === operation) reads.delete(key); });
      reads.set(key, operation); return operation;
    };
    const loadSkills = async (options: any = {}) => {
      const generation = session(), version = revision(hostId), cwd = view.projectPath;
      const result = await settingsRpc(hostId, 'skills/list', { cwds: view.projectPath ? [view.projectPath] : [], forceReload: !!options.forceReload });
      assertCurrent(hostId, generation, version);
      if (entries.get(hostId)?.state !== view || cwd !== view.projectPath) return result;
      view.skills = result.data || []; return result;
    };
    const loadIntegrations = async () => {
      const generation = session(), version = revision(hostId), cwd = view.projectPath;
      const results = await Promise.allSettled([
        loadSkills({ forceReload: true }), settingsRpc(hostId, 'app/list', { limit: 100 }),
        settingsRpc(hostId, 'mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
      ]);
      if (!current(hostId, generation, version) || entries.get(hostId)?.state !== view || cwd !== view.projectPath) return;
      view.integrationErrors = results.flatMap((result, index) => result.status === 'rejected' ? [{ source: ['skills', 'apps', 'mcp'][index], message: result.reason?.message || '读取失败' }] : []);
      if (results[1].status === 'fulfilled') view.apps = results[1].value.data || [];
      if (results[2].status === 'fulfilled') view.mcpServers = results[2].value.data || [];
    };
    entry = { state: view, api: { rpc: (method: string, params?: any) => settingsRpc(hostId, method, params), readConfig, loadIntegrations, loadSkills,
      requestHttp: http, runtimeIdentity: () => ({ authenticationGeneration: identity().authenticationGeneration, engineId: view.engineId }),
    } };
    entries.set(hostId, entry); return entry;
  }
  async function refreshRuntimeInformation(hostId = main.hostId) {
    const generation = session();
    const version = revision(hostId);
    const key = JSON.stringify([generation, hostId, version, 'runtime']);
    if (reads.has(key)) return reads.get(key);
    const operation = http(`${path(hostId)}/runtime/information`, {}, false).then(information => {
      assertCurrent(hostId, generation, version);
      main.runtimeInformation[hostId] = information;
      const view = hostSettings(hostId).state;
      view.connected = !!information.runtime?.connected; view.runtimePaused = !!information.runtime?.paused;
      view.engineId = information.runtime?.engineId || null;
      if (Array.isArray(information.models)) view.models = information.models;
      return information;
    }).finally(() => { if (reads.get(key) === operation) reads.delete(key); });
    reads.set(key, operation); return operation;
  }
  const readHostCodexSettings = async (hostId = main.hostId) => {
    const generation = session(), version = revision(hostId); const result = await http(`${path(hostId)}/codex-settings`, {}, false);
    assertCurrent(hostId, generation, version);
    return result;
  };
  async function mutate(hostId: string, action: string, input: any) {
    const generation = session();
    if (action !== 'login/cancel') invalidateHostSettings(hostId);
    const version = revision(hostId);
    const result = await http(`${path(hostId)}/codex-settings/${action}`, { method: 'POST', body: JSON.stringify(input) }, false);
    if (!selected(hostId, generation)) throw new Error('登录状态或主机已变化，请在原主机核对操作结果');
    // A provider switch deliberately re-handshakes the engine. Its own
    // bridge/status may invalidate the revision before this HTTP ACK arrives.
    if (action === 'provider') { invalidateHostSettings(hostId); onConfigurationChanged(hostId); }
    else assertCurrent(hostId, generation, version);
    return result;
  }
  return { hostSettings, refreshRuntimeInformation, readHostCodexSettings, resetHostSettings, invalidateHostSettings,
    updateHostCodexProvider: (hostId: string, input: any) => mutate(hostId, 'provider', input),
    loginHostCodexAccount: (hostId: string, input: any) => mutate(hostId, 'login', input),
    cancelHostCodexLogin: (hostId: string, loginId: string) => mutate(hostId, 'login/cancel', { loginId }),
    logoutHostCodexAccount: (hostId: string) => mutate(hostId, 'logout', {}),
  };
}
