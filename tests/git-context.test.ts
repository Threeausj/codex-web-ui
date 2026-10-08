import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryCandidates, missingRepository } from '../src/lib/git-context';

test('repository recovery prefers recent native operation directories and stays within the selected host', () => {
  const items = [{ cwd: '/old' }, { item: { cwd: '/recent' } }, { cwd: '/recent' }, { cwd: '/' }, { cwd: 'relative' }, { cwd: '/bad\u0000path' }];
  const projects = [{ path: '/other-machine', hostId: 'other' }, { path: '/saved', hostId: 'nas' }, { path: '/local' }];
  assert.deepEqual(repositoryCandidates(items, projects, 'nas', '/old'), ['/recent', '/saved']);
  assert.equal(repositoryCandidates(Array.from({ length: 20 }, (_, index) => ({ cwd: '/p' + index })), [], 'nas', '/').length, 8);
  assert.equal(missingRepository('fatal: not a git repository (or any of the parent directories): .git'), true);
  assert.equal(missingRepository('connection timed out'), false);
  assert.equal(missingRepository('Permission denied'), false);
});
