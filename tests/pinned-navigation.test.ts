import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedNavigation } from '../src/lib/pinned-navigation';

test('pinned projects and chats share one recency order without treating metadata updates as activity', () => {
  const projects = [{ hostId: 'nas', path: '/a', nativeProjectId: 'native-a' }, { hostId: 'nas', path: '/b' }];
  const threads = [
    { hostId: 'nas', id: 'old', cwd: '/a', recencyAt: 10, updatedAt: 9999 },
    { hostId: 'nas', id: 'moved', cwd: '/other', projectId: 'native-a', recencyAt: 60 },
    { hostId: 'nas', id: 'newer', cwd: '/b', recencyAt: 40 },
    { hostId: 'nas', id: 'independent', cwd: '/elsewhere', recencyAt: 50 },
    { hostId: 'other', id: 'cross-host', cwd: '/b', recencyAt: 999 },
  ];
  const pins = [
    { kind: 'project' as const, hostId: 'nas', id: '/b' },
    { kind: 'thread' as const, hostId: 'nas', id: 'independent' },
    { kind: 'project' as const, hostId: 'nas', id: '/a' },
  ];
  const result = pinnedNavigation(projects, threads, pins);
  assert.deepEqual(result.map(entry => [entry.kind, entry.activityAt]), [['project', 60], ['thread', 50], ['project', 40]]);
  assert.deepEqual(pins.map(pin => pin.id), ['/b', 'independent', '/a']);
  assert.deepEqual(threads.map(thread => thread.id), ['old', 'moved', 'newer', 'independent', 'cross-host']);
});

test('equal recency pins retain saved order and missing or duplicate pins do not produce empty rows', () => {
  const projects = [{ path: '/empty' }, { hostId: 'nas', path: '/empty' }];
  const threads = [{ id: 'same', createdAt: 20 }, { hostId: 'nas', id: 'same', recencyAt: 20 }];
  const pins = [
    { kind: 'thread' as const, hostId: 'nas', id: 'same' },
    { kind: 'thread' as const, hostId: 'local', id: 'same' },
    { kind: 'thread' as const, hostId: 'nas', id: 'same' },
    { kind: 'project' as const, hostId: 'local', id: '/missing' },
    { kind: 'project' as const, hostId: 'nas', id: '/empty' },
    { kind: 'project' as const, hostId: 'local', id: '/empty' },
  ];
  assert.deepEqual(pinnedNavigation(projects, threads, pins).map(entry => entry.key), [
    JSON.stringify(['thread', 'nas', 'same']), JSON.stringify(['thread', 'local', 'same']),
    JSON.stringify(['project', 'nas', '/empty']), JSON.stringify(['project', 'local', '/empty']),
  ]);
});
