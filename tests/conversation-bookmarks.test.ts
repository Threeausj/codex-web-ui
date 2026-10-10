import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBookmarkMessages, retainBookmarkTargets, useConversationBookmarks } from '../src/lib/conversation-bookmarks';
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
