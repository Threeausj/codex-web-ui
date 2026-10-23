import assert from 'node:assert/strict';
import test from 'node:test';
import { pushTarget, pushTargetFromUrl } from '../src/lib/push-navigation';

test('notification targets accept existing conversations and strictly identified tmux panes', () => {
  assert.deepEqual(pushTarget({ hostId: 'nas', threadId: 'thread-1' }), { hostId: 'nas', threadId: 'thread-1' });
  assert.deepEqual(pushTargetFromUrl(new URL('https://codex.example/?host=nas&tmuxSession=%242&tmuxPane=%255')), {
    hostId: 'nas', tmuxSession: '$2', tmuxPane: '%5',
  });
  assert.deepEqual(pushTarget({ hostId: 'nas', threadId: 'thread-1', tmuxSession: '$2', tmuxPane: '%5' }), {
    hostId: 'nas', threadId: 'thread-1', tmuxSession: '$2', tmuxPane: '%5',
  });
  for (const value of [null, {}, { hostId: 'nas' }, { hostId: '../api', tmuxSession: '$2' },
    { hostId: 'nas', tmuxSession: '$(touch /tmp/test)' }, { hostId: 'nas', tmuxSession: '$1', tmuxPane: '%1;send-keys' }])
    assert.equal(pushTarget(value), null);
});
