import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBindingKey, retainProjectBindings } from '../src/lib/project-membership.js';

const target = { id: 'web-target', hostId: 'nas', path: '/work', name: 'Work', rootPaths: ['/work', '/docs'], nativeProjectId: 'native-target' };

test('removing another project or refreshing settings retains unchanged native membership without mutating the response', () => {
  const incoming = { id: 'new-web-id', hostId: 'nas', path: '/work', name: 'Work', rootPaths: ['/docs', '/work', '/docs'] };
  const result = retainProjectBindings([{ ...target, path: '/' }, target], [incoming]);
  assert.equal(result[0]!.nativeProjectId, 'native-target');
  assert.equal(result[0]!.id, 'new-web-id');
  assert.equal(Object.hasOwn(incoming, 'nativeProjectId'), false);
  assert.notEqual(result[0], incoming);
  assert.equal(projectBindingKey(result[0]!), projectBindingKey(target));
});

test('identical paths on different hosts never share a native project identity', () => {
  const result = retainProjectBindings([target], [{ ...target, hostId: 'other', nativeProjectId: 'unverified-response' }]);
  assert.equal(result[0]!.nativeProjectId, undefined);
});

test('changed roots or names invalidate native membership while unrelated projects remain bound', () => {
  for (const change of [{ name: 'Another project' }, { rootPaths: ['/work', '/elsewhere'] }, { path: '/elsewhere' }]) {
    const source = { hostId: 'nas', path: '/', name: 'NAS', nativeProjectId: 'native-source' };
    const result = retainProjectBindings([source, target], [{ ...target, ...change }, { ...source, nativeProjectId: 'unverified-response' }]);
    assert.equal(result[0]!.nativeProjectId, undefined);
    assert.equal(result[1]!.nativeProjectId, 'native-source');
  }
});
