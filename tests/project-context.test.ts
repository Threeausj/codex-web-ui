import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTLESS_THREAD_SOURCE, isProjectlessThread } from '../shared/project-context.js';
import { matchesProject } from '../src/lib/navigation.js';

test('explicitly projectless chats retain a valid cwd without matching that project', () => {
  const project = { hostId: 'nas', path: '/workspace/app', rootPaths: ['/workspace/shared'], nativeProjectId: 'native-app' };
  const thread = { hostId: 'nas', cwd: '/workspace/app', projectId: null, threadSource: PROJECTLESS_THREAD_SOURCE };
  assert.equal(isProjectlessThread(thread), true);
  assert.equal(matchesProject(thread, project), false);
  assert.equal(matchesProject({ ...thread, cwd: '/workspace/shared' }, project), false);
  assert.equal(matchesProject({ ...thread, projectId: undefined }, project), false);
});

test('a later native project move overrides the no-project origin while legacy directory grouping remains compatible', () => {
  const project = { path: '/workspace/app', nativeProjectId: 'native-app' };
  const moved = { cwd: '/elsewhere', projectId: 'native-app', threadSource: PROJECTLESS_THREAD_SOURCE };
  assert.equal(isProjectlessThread(moved), false);
  assert.equal(matchesProject(moved, project), true);
  assert.equal(matchesProject({ cwd: project.path, projectId: null }, project), true);
  assert.equal(matchesProject({ cwd: project.path }, project), true);
  assert.equal(isProjectlessThread(null), false);
});
