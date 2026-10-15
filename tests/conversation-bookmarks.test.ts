import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBookmark, mergeBookmarkMessages, retainBookmarkTargets, useConversationBookmarks } from '../src/lib/conversation-bookmarks';
import type { BookmarkScope, ConversationBookmark } from '../shared/bookmarks';

const project: BookmarkScope = { hostId: 'local', projectPath: '/project' };
const remote: BookmarkScope = { hostId: 'remote', projectPath: '/project' };
const bookmark = (scope = project, id = 'bookmark-a', name = 'A saved name'): ConversationBookmark => ({
  ...scope, id, name, createdAt: 1, updatedAt: 1,
  source: { threadId: 'same-thread', turnId: 'same-turn', itemId: 'same-item', text: 'Selected conversation text', threadName: 'Conversation' },
});
function fixture() {
  let authentication = 1;
  const requests: { path: string; options?: RequestInit; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const store = useConversationBookmarks({
    runtimeIdentity: () => ({ authenticationGeneration: authentication }),
    requestHttp: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
  });
  return { store, requests, changeAuthentication: () => { authentication++; } };
}

test('a late project response cannot replace bookmarks for another host with the same project path', async () => {
  const f = fixture();
  const old = f.store.open(project, 'Local project');
  const current = f.store.open(remote, 'Remote project');
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await old;
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.loading, true);
  f.requests[1]!.resolve({ bookmarks: [bookmark(remote)] });
  await current;
  assert.deepEqual(f.store.state.entries, [bookmark(remote)]);
  assert.equal(f.store.state.projectName, 'Remote project');
  assert.equal(f.store.state.loading, false);
});

test('authentication changes prevent delayed bookmark contents and request errors from reaching the new session', async () => {
  const f = fixture();
  const old = f.store.open(project, 'Project');
  f.changeAuthentication();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await old;
  assert.deepEqual(f.store.state.entries, []);
  const failed = f.store.refresh();
  f.changeAuthentication();
  f.requests[1]!.reject(new Error('A private error from the old login'));
  await failed;
  assert.equal(f.store.state.error, '');
});

test('logout clears pending operations and late replies cannot restore private bookmarks', async () => {
  const f = fixture();
  const opening = f.store.open(project, 'Project');
  f.changeAuthentication();
  f.store.clear();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  assert.equal(f.store.state.open, false);
  assert.equal(f.store.state.scope, null);
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.loading, false);
  assert.equal(f.store.state.busyId, '');
});

test('an older refresh cannot undo an accepted rename or restore a removed bookmark', async () => {
  const f = fixture();
  const opening = f.store.open(project, 'Project');
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  const refreshing = f.store.refresh();
  const renamed = f.store.save(bookmark(), 'Accepted new name');
  f.requests[2]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'Accepted new name') });
  await renamed;
  f.requests[1]!.resolve({ bookmarks: [bookmark()] });
  await refreshing;
  assert.equal(f.store.state.entries[0]!.name, 'Accepted new name');
  assert.equal(f.store.state.loading, false);
  const again = f.store.refresh();
  const removing = f.store.remove(f.store.state.entries[0]!);
  f.requests[4]!.resolve({ ok: true });
  await removing;
  f.requests[3]!.resolve({ bookmarks: [bookmark()] });
  await again;
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.loading, false);
});

test('a pending removal failure from another project cannot overwrite the current project error', async () => {
  const f = fixture();
  const opening = f.store.open(project, 'Local');
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  const removing = f.store.remove(bookmark());
  const remoteOpening = f.store.open(remote, 'Remote');
  f.requests[2]!.resolve({ bookmarks: [bookmark(remote)] });
  await remoteOpening;
  f.requests[1]!.reject(new Error('Local removal failed'));
  await removing;
  assert.equal(f.store.state.error, '');
  assert.deepEqual(f.store.state.entries, [bookmark(remote)]);
});

test('idempotent creation adopts the existing bookmark and retains its first saved name', async () => {
  const f = fixture();
  const opening = f.store.open(project, 'Project');
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  const { id, createdAt, updatedAt, ...input } = bookmark();
  const adding = f.store.save(input, 'A second attempt');
  assert.equal(f.requests[1]!.path, '/bookmarks');
  f.requests[1]!.resolve({ bookmark: bookmark() });
  const result = await adding;
  assert.equal(result.id, id);
  assert.equal(result.name, 'A saved name');
  assert.deepEqual(f.store.state.entries, [bookmark()]);
});

test('the global catalog is lazy, coalesces concurrent consumers and remains cached when the panel reopens', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  const indexing = f.store.ensureIndex();
  const opening = f.store.openAll();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.path, '/bookmarks?all=true');
  assert.equal(f.store.state.indexLoading, true);
  assert.equal(f.store.state.loading, true);
  assert.equal(f.store.state.allProjects, true);
  assert.equal(f.store.state.scope, null);
  const entries = [bookmark(), bookmark(remote, 'remote-bookmark')];
  f.requests[0]!.resolve({ bookmarks: entries });
  await Promise.all([indexing, opening]);
  assert.deepEqual(f.store.state.allEntries, entries);
  assert.deepEqual(f.store.state.entries, entries);
  assert.equal(f.store.state.indexLoading, false);
  assert.equal(f.store.state.loading, false);
  f.store.close();
  await f.store.openAll();
  await f.store.ensureIndex();
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.state.open, true);
});

test('global refresh reloads external changes while a failed refresh retains the cached bookmarks and can retry', async () => {
  const f = fixture();
  const opening = f.store.openAll();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  const failed = f.store.refresh();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.store.state.entries, [bookmark()]);
  f.requests[1]!.reject(new Error('Temporarily unavailable'));
  await failed;
  assert.equal(f.store.state.indexError, 'Temporarily unavailable');
  assert.equal(f.store.state.error, 'Temporarily unavailable');
  assert.deepEqual(f.store.state.allEntries, [bookmark()]);
  assert.equal(f.store.state.indexLoading, false);
  const retry = f.store.refresh();
  f.requests[2]!.resolve({ bookmarks: [bookmark(remote, 'external', 'Created elsewhere')] });
  await retry;
  assert.equal(f.store.state.indexError, '');
  assert.equal(f.store.state.error, '');
  assert.deepEqual(f.store.state.entries, [bookmark(remote, 'external', 'Created elsewhere')]);
});

test('switching between the project panel and global catalog ignores obsolete panel responses without losing the global load', async () => {
  const f = fixture();
  const projectOpening = f.store.open(project, 'Local project');
  const allOpening = f.store.openAll();
  f.requests[0]!.reject(new Error('A stale project error'));
  await projectOpening;
  assert.equal(f.store.state.error, '');
  assert.equal(f.store.state.loading, true);
  const remoteOpening = f.store.open(remote, 'Remote project');
  f.requests[1]!.resolve({ bookmarks: [bookmark()] });
  await allOpening;
  assert.deepEqual(f.store.state.allEntries, [bookmark()]);
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.loading, true);
  assert.equal(f.store.state.allProjects, false);
  f.requests[2]!.resolve({ bookmarks: [bookmark(remote)] });
  await remoteOpening;
  assert.deepEqual(f.store.state.entries, [bookmark(remote)]);
  await f.store.openAll();
  assert.deepEqual(f.store.state.entries, [bookmark()]);
  assert.equal(f.requests.length, 3);
});

test('catalog snapshots retain accepted creates, renames and deletions while also loading unrelated bookmarks', async () => {
  const f = fixture();
  const opening = f.store.openAll();
  const original = bookmark();
  const renamed = f.store.save(original, 'Updated locally');
  f.requests[1]!.resolve({ bookmark: bookmark(project, original.id, 'Updated locally') });
  await renamed;
  const deleted = bookmark(remote, 'removed');
  const removing = f.store.remove(deleted);
  f.requests[2]!.resolve({ ok: true });
  await removing;
  const created = bookmark(remote, 'new', 'Added while reading');
  const { id, createdAt, updatedAt, ...input } = created;
  const creating = f.store.save(input, created.name);
  f.requests[3]!.resolve({ bookmark: created });
  await creating;
  const unrelated = bookmark(remote, 'unrelated');
  f.requests[0]!.resolve({ bookmarks: [original, deleted, unrelated] });
  await opening;
  assert.deepEqual(f.store.state.allEntries.map(entry => [entry.id, entry.name]), [
    [original.id, 'Updated locally'], [created.id, created.name], [unrelated.id, unrelated.name],
  ]);
  assert.deepEqual(f.store.state.entries, f.store.state.allEntries);
  assert.equal(f.store.state.loading, false);
  assert.equal(f.store.state.busyId, '');
});

test('accepted scoped writes update the global cache even after its panel switches to another host', async () => {
  const f = fixture();
  const indexing = f.store.ensureIndex();
  f.requests[0]!.resolve({ bookmarks: [bookmark(), bookmark(remote)] });
  await indexing;
  const opening = f.store.open(project, 'Local');
  f.requests[1]!.resolve({ bookmarks: [bookmark()] });
  await opening;
  const renaming = f.store.save(bookmark(), 'New local name');
  const remoteOpening = f.store.open(remote, 'Remote');
  f.requests[3]!.resolve({ bookmarks: [bookmark(remote)] });
  await remoteOpening;
  f.requests[2]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'New local name') });
  await renaming;
  assert.deepEqual(f.store.state.entries, [bookmark(remote)]);
  assert.equal(f.store.state.allEntries.find(entry => entry.hostId === 'local')!.name, 'New local name');
  assert.equal(f.store.state.allEntries.find(entry => entry.hostId === 'remote')!.name, 'A saved name');
  await f.store.openAll();
  assert.equal(f.store.state.entries.length, 2);
});

test('a scoped refresh merges writes instead of dropping unrelated saved entries', async () => {
  const f = fixture();
  const opening = f.store.open(project, 'Project');
  const renaming = f.store.save(bookmark(), 'New name');
  f.requests[1]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'New name') });
  await renaming;
  f.requests[0]!.resolve({ bookmarks: [bookmark(), bookmark(project, 'another', 'Another bookmark')] });
  await opening;
  assert.deepEqual(f.store.state.entries.map(entry => [entry.id, entry.name]), [
    ['another', 'Another bookmark'], ['bookmark-a', 'New name'],
  ]);
});

test('saving before catalog loading does not mark a partial index complete or lose the accepted bookmark during its first read', async () => {
  const f = fixture();
  const saved = f.store.save(bookmark(), 'Saved before search');
  f.requests[0]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'Saved before search') });
  await saved;
  assert.equal(f.store.state.allEntries[0]!.name, 'Saved before search');
  const indexing = f.store.ensureIndex();
  assert.equal(f.requests[1]!.path, '/bookmarks?all=true');
  f.requests[1]!.resolve({ bookmarks: [bookmark(project, 'bookmark-a', 'Saved before search'), bookmark(remote, 'another')] });
  await indexing;
  assert.equal(f.store.state.allEntries.length, 2);
});

test('clearing the store fences both pending index and writes even when the authentication number does not change', async () => {
  const f = fixture();
  const indexing = f.store.openAll();
  const saving = f.store.save(bookmark(), 'Private saved name');
  f.store.clear();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  f.requests[1]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'Private saved name') });
  await Promise.all([indexing, saving]);
  assert.equal(f.store.state.open, false);
  assert.equal(f.store.state.allProjects, false);
  assert.deepEqual(f.store.state.entries, []);
  assert.deepEqual(f.store.state.allEntries, []);
  assert.equal(f.store.state.indexLoading, false);
  const fresh = f.store.ensureIndex();
  assert.equal(f.requests.length, 3);
  f.requests[2]!.resolve({ bookmarks: [] });
  await fresh;
});

test('a changed authentication identity neither reuses the previous catalog nor coalesces with its pending request', async () => {
  const f = fixture();
  const old = f.store.ensureIndex();
  f.changeAuthentication();
  const fresh = f.store.openAll();
  assert.equal(f.requests.length, 2);
  f.requests[0]!.reject(new Error('Private old session failure'));
  await old;
  assert.equal(f.store.state.indexError, '');
  assert.equal(f.store.state.indexLoading, true);
  f.requests[1]!.resolve({ bookmarks: [bookmark(remote)] });
  await fresh;
  assert.deepEqual(f.store.state.allEntries, [bookmark(remote)]);
  f.changeAuthentication();
  const next = f.store.ensureIndex();
  assert.deepEqual(f.store.state.allEntries, []);
  assert.deepEqual(f.store.state.entries, []);
  f.requests[2]!.resolve({ bookmarks: [] });
  await next;
});

test('bookmark search matches saved names, original quotations and titles with case-insensitive query tokens', () => {
  const entry = bookmark();
  assert.equal(matchesBookmark(entry, ''), true);
  assert.equal(matchesBookmark(entry, '   '), true);
  assert.equal(matchesBookmark(entry, 'saved NAME'), true);
  assert.equal(matchesBookmark(entry, 'SELECTED text'), true);
  assert.equal(matchesBookmark(entry, 'conversation'), true);
  assert.equal(matchesBookmark(entry, 'saved conversation text'), true);
  assert.equal(matchesBookmark(entry, 'saved irrelevant'), false);
  assert.equal(matchesBookmark(entry, '/project'), false);
  assert.equal(matchesBookmark(entry, 'same-thread'), false);
});

test('mutations outside an open panel update the catalog and release their busy state', async () => {
  const f = fixture();
  const indexing = f.store.ensureIndex();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await indexing;
  const removing = f.store.remove(bookmark());
  f.requests[1]!.resolve({ ok: true });
  await removing;
  assert.deepEqual(f.store.state.allEntries, []);
  assert.equal(f.store.state.busyId, '');
});

test('a write in a new authentication session cannot retain private entries from the previous catalog', async () => {
  const f = fixture();
  const indexing = f.store.ensureIndex();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  await indexing;
  f.changeAuthentication();
  const saving = f.store.save(bookmark(remote, 'new-private-entry'), 'New login bookmark');
  assert.deepEqual(f.store.state.allEntries, []);
  f.requests[1]!.resolve({ bookmark: bookmark(remote, 'new-private-entry', 'New login bookmark') });
  await saving;
  assert.deepEqual(f.store.state.allEntries, [bookmark(remote, 'new-private-entry', 'New login bookmark')]);
  const freshIndex = f.store.ensureIndex();
  assert.equal(f.requests.length, 3);
  f.requests[2]!.resolve({ bookmarks: [bookmark(remote, 'new-private-entry', 'New login bookmark')] });
  await freshIndex;
});

test('a synchronous request error does not leave the catalog permanently coalesced with a completed request', async () => {
  let attempts = 0;
  const store = useConversationBookmarks({
    runtimeIdentity: () => ({ authenticationGeneration: 1 }),
    requestHttp: () => {
      if (++attempts === 1) throw new Error('Synchronous request setup failed');
      return Promise.resolve({ bookmarks: [] });
    },
  });
  await store.ensureIndex();
  assert.equal(store.state.indexError, 'Synchronous request setup failed');
  await store.ensureIndex();
  assert.equal(attempts, 2);
  assert.equal(store.state.indexError, '');
  assert.equal(store.state.indexLoading, false);
});

test('host topology removes cached bookmarks immediately, retains other hosts and does not start an eager request', async () => {
  const f = fixture();
  assert.equal(f.store.setHosts(['local', 'remote']), true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.store.setHosts(['remote', 'local', 'local']), false);
  const opening = f.store.openAll();
  f.requests[0]!.resolve({ bookmarks: [bookmark(), bookmark(remote, 'remote-a')] });
  await opening;
  assert.equal(f.store.setHosts(['local']), true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.store.state.allEntries, [bookmark()]);
  assert.deepEqual(f.store.state.entries, [bookmark()]);
  const reloading = f.store.ensureIndex();
  assert.equal(f.requests.length, 2);
  f.requests[1]!.resolve({ bookmarks: [bookmark(), bookmark(remote, 'stale-server-entry')] });
  await reloading;
  assert.deepEqual(f.store.state.allEntries, [bookmark()]);
  assert.equal(f.store.state.loading, false);
});

test('a pending catalog from a deleted host cannot replace a new catalog or stop its loading state', async () => {
  const f = fixture();
  f.store.setHosts(['local', 'remote']);
  const old = f.store.openAll();
  f.store.setHosts(['local']);
  const fresh = f.store.ensureIndex();
  assert.equal(f.requests.length, 2);
  f.requests[0]!.resolve({ bookmarks: [bookmark(remote)] });
  await old;
  assert.deepEqual(f.store.state.allEntries, []);
  assert.equal(f.store.state.indexLoading, true);
  assert.equal(f.store.state.loading, true);
  f.requests[1]!.resolve({ bookmarks: [bookmark()] });
  await fresh;
  assert.deepEqual(f.store.state.allEntries, [bookmark()]);
  assert.equal(f.store.state.indexLoading, false);
});

test('removing and readding a host fences its pending writes while preserving accepted writes to unrelated hosts', async () => {
  const f = fixture();
  f.store.setHosts(['local', 'remote']);
  const indexing = f.store.openAll();
  f.requests[0]!.resolve({ bookmarks: [bookmark(), bookmark(remote, 'remote-a')] });
  await indexing;
  const oldRemote = f.store.save(bookmark(remote, 'remote-a'), 'Stale remote rename');
  const local = f.store.save(bookmark(), 'Accepted local rename');
  f.store.setHosts(['local']);
  f.store.setHosts(['local', 'remote']);
  f.requests[1]!.resolve({ bookmark: bookmark(remote, 'remote-a', 'Stale remote rename') });
  f.requests[2]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'Accepted local rename') });
  await Promise.all([oldRemote, local]);
  assert.deepEqual(f.store.state.allEntries, [bookmark(project, 'bookmark-a', 'Accepted local rename')]);
  assert.deepEqual(f.store.state.entries, f.store.state.allEntries);
});

test('removing a host also fences its scoped panel and its delayed removal error', async () => {
  const f = fixture();
  f.store.setHosts(['local', 'remote']);
  const opening = f.store.open(remote, 'Remote project');
  const removing = f.store.remove(bookmark(remote));
  f.store.setHosts(['local']);
  f.requests[0]!.resolve({ bookmarks: [bookmark(remote)] });
  f.requests[1]!.reject(new Error('Private stale host error'));
  await Promise.all([opening, removing]);
  assert.deepEqual(f.store.state.entries, []);
  assert.equal(f.store.state.error, '');
  assert.equal(f.store.state.loading, false);
  assert.equal(f.store.state.busyId, '');
  await f.store.refresh();
  assert.equal(f.requests.length, 2);
});

test('logout clears topology and late responses without preventing a different host set in the next session', async () => {
  const f = fixture();
  f.store.setHosts(['local']);
  const old = f.store.ensureIndex();
  const pendingSave = f.store.save(bookmark(), 'Old private name');
  f.changeAuthentication();
  f.store.clear();
  assert.equal(f.store.setHosts(['remote']), true);
  assert.equal(f.requests.length, 2);
  const fresh = f.store.openAll();
  f.requests[0]!.resolve({ bookmarks: [bookmark()] });
  f.requests[1]!.resolve({ bookmark: bookmark(project, 'bookmark-a', 'Old private name') });
  await Promise.all([old, pendingSave]);
  assert.deepEqual(f.store.state.allEntries, []);
  assert.equal(f.store.state.indexLoading, true);
  f.requests[2]!.resolve({ bookmarks: [bookmark(), bookmark(remote)] });
  await fresh;
  assert.deepEqual(f.store.state.entries, [bookmark(remote)]);
});

test('an isolated bookmark stays before the confirmed history window and uses the current message contents', () => {
  const previous = [
    { id: 'far-older', historyBookmarkTarget: true, historySummary: true, items: [{ id: 'answer', turnId: 'far-older', text: 'Outdated metadata' }] },
    { id: 'old-window', items: [] },
  ];
  const continuous = [{ id: 'older-page', items: [] }, { id: 'recent-page', items: [] }];
  const live = [{ id: 'answer', turnId: 'far-older', text: 'Confirmed full answer' }, { id: 'latest', turnId: 'recent-page', text: 'Recent answer' }];
  const retained = retainBookmarkTargets(continuous, previous, live);
  assert.deepEqual(retained.map(turn => turn.id), ['far-older', 'older-page', 'recent-page']);
  assert.deepEqual(retained[0]!.items, [live[0]]);
  assert.equal(retained[0]!.historyBookmarkTarget, true);
  assert.equal(previous[0]!.items[0]!.text, 'Outdated metadata');
  assert.deepEqual(continuous.map(turn => turn.id), ['older-page', 'recent-page']);
});

test('native pagination reaching a bookmark replaces its temporary turn marker without duplicate messages or turn metadata', () => {
  const target = { id: 'bookmark-turn', historyBookmarkTarget: true, historySummary: true, items: [] };
  const confirmed = { id: 'bookmark-turn', status: 'completed', historySummary: false, items: [{ id: 'native-answer', turnId: 'bookmark-turn' }] };
  const continuous = [{ id: 'previous-turn', items: [] }, confirmed, { id: 'recent-turn', items: [] }];
  const retained = retainBookmarkTargets(continuous, [target], [{ id: 'stale-answer', turnId: 'bookmark-turn' }]);
  assert.deepEqual(retained.map(turn => turn.id), ['previous-turn', 'bookmark-turn', 'recent-turn']);
  assert.equal(retained[1], confirmed);
  assert.equal(retained[1]!.historyBookmarkTarget, undefined);
  assert.deepEqual(retained[1]!.items, confirmed.items);
});

test('revealing a summary-hidden bookmark keeps native compaction and commentary before its already known final answer', () => {
  const user = { id: 'user', type: 'userMessage', text: 'Initial request' };
  const final = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'The final answer' };
  const compaction = { id: 'compaction', type: 'contextCompaction' };
  const target = { id: 'target', type: 'agentMessage', phase: 'commentary', text: 'Saved commentary after compaction' };
  const summary = [user, final];
  const merged = mergeBookmarkMessages(summary, [user, compaction, target]);
  assert.deepEqual(merged.map(item => item.id), ['user', 'compaction', 'target', 'final']);
  assert.deepEqual(summary, [user, final]);
});

test('bookmark prefix ordering preserves newer live messages while replacing a truncated cache and avoiding page overlap duplicates', () => {
  const known = [
    { id: 'user', text: 'User request' },
    { id: 'target', text: 'An answer still streaming' },
    { id: 'cached', text: 'A truncated cache', cacheTruncated: true },
    { id: 'final', text: 'Known final answer' },
  ];
  const incoming = [
    { id: 'user', text: 'User request' },
    { id: 'target', text: 'Stale native snapshot' },
    { id: 'cached', text: 'Full native answer' },
    { id: 'target', text: 'Overlapping page also stale' },
  ];
  const merged = mergeBookmarkMessages(known, incoming, new Set(['target']));
  assert.deepEqual(merged.map(item => item.id), ['user', 'target', 'cached', 'final']);
  assert.equal(merged[1], known[1]);
  assert.equal(merged[2]!.text, 'Full native answer');
  assert.equal(merged[2]!.cacheTruncated, undefined);
  assert.equal(new Set(merged.map(item => item.id)).size, merged.length);
});

test('revealing a message keeps already loaded tools before compaction without retaining newly read command output', () => {
  const user = { id: 'user', type: 'userMessage' };
  const command = { id: 'known-command', type: 'commandExecution', aggregatedOutput: 'Already expanded process output' };
  const compaction = { id: 'compaction', type: 'contextCompaction' };
  const target = { id: 'target', type: 'agentMessage', phase: 'commentary' };
  const final = { id: 'final', type: 'agentMessage', phase: 'final_answer' };
  const merged = mergeBookmarkMessages([user, command, final], [user, compaction, target], new Set(),
    ['user', 'known-command', 'unloaded-command', 'compaction', 'target']);
  assert.deepEqual(merged.map(item => item.id), ['user', 'known-command', 'compaction', 'target', 'final']);
  assert.equal(merged[1], command);
  assert.equal(merged.some(item => item.id === 'unloaded-command'), false);
});
