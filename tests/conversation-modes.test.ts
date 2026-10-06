import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalMethodSupported, nativeCollaborationMode, skillInventory, skillMention } from '../src/lib/conversation-modes.js';

test('Goal capability probing distinguishes thread lookup from disabled, unsupported, and disconnected servers', () => {
  assert.equal(goalMethodSupported({ code: -32600, message: 'thread not found: 00000000-0000-0000-0000-000000000000' }), true);
  for (const error of [{ code: -32600, message: 'goals feature is disabled' }, { code: -32601, message: 'Method not found' }, { message: 'Connection lost' }, { code: -32600, message: 'invalid params' }])
    assert.equal(goalMethodSupported(error), false);
});

test('native collaboration mode uses built-in instructions and requires an actual model', () => {
  assert.deepEqual(nativeCollaborationMode('plan', 'gpt-test', 'medium'), {
    mode: 'plan', settings: { model: 'gpt-test', reasoning_effort: 'medium', developer_instructions: null },
  });
  assert.throws(() => nativeCollaborationMode('default', '', 'medium'), /模型配置/);
});

test('skill inventory isolates cwd and rejects duplicate or invalid paths', () => {
  const skill = { name: 'writer', path: '/skills/writer/SKILL.md', enabled: true };
  assert.deepEqual(skillInventory({ data: [
    { cwd: '/one', skills: [skill, skill, { name: 'invalid', path: '../SKILL.md' }] },
    { cwd: '/two', skills: [{ name: 'remote', path: '/remote/SKILL.md' }] },
  ] }, '/one'), [skill]);
});

test('skill references match a whole name, including punctuation, without invoking prefix skills', () => {
  assert.equal(skillMention('Use $writer-extra here', 'writer'), false);
  assert.equal(skillMention('Use $writer_extra here', 'writer'), false);
  assert.equal(skillMention('Use $writer.', 'writer'), true);
  assert.equal(skillMention('$plugin:writer', 'plugin:writer'), true);
  assert.equal(skillMention('$a.b', 'a.b'), true);
  assert.equal(skillMention('$axb', 'a.b'), false);
});
