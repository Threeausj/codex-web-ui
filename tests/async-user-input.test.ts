import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncUserInputQuestions } from '../shared/async-user-input.js';

test('native async question metadata supports choices and free text without mutating messages', () => {
  const item = { type: 'agentMessage', delivery: 'async', questions: [
    { title: '  Choose an option? ', options: [' Option A ', 'Option B'] },
    { title: 'Your requirements?', options: null },
    { title: 'Anything else?' },
  ] };
  const before = structuredClone(item);
  assert.deepEqual(asyncUserInputQuestions(item), [
    { title: 'Choose an option?', options: ['Option A', 'Option B'] },
    { title: 'Your requirements?', options: null },
    { title: 'Anything else?', options: null },
  ]);
  assert.deepEqual(item, before);
});

test('prose, incomplete items and malformed question metadata never become interactive questions', () => {
  const valid = { type: 'agentMessage', delivery: 'async', questions: [{ title: 'Choose?', options: ['A', 'B'] }] };
  for (const item of [
    null, [], 'Choose?', { ...valid, type: 'dynamicToolCall' }, { ...valid, delivery: null },
    { type: 'agentMessage', text: 'Choose?\n- A\n- B' },
    { ...valid, questions: [] }, { ...valid, questions: 'Choose?' },
    { ...valid, questions: [null] }, { ...valid, questions: [{ title: ' ' }] },
    { ...valid, questions: [{ title: 'Choose?', options: 'A' }] },
    { ...valid, questions: [{ title: 'Choose?', options: ['A', 1] }] },
    { ...valid, questions: [{ title: 'Choose?', options: ['A', ' '] }] },
    { ...valid, questions: [...valid.questions, { title: 42 }] },
  ]) assert.deepEqual(asyncUserInputQuestions(item), []);
});
