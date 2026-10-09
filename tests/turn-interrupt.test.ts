import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptConflictCandidate } from '../src/lib/turn-interrupt';

test('a Stop conflict identifies only the ID paired with the original request, in either order', () => {
  for (const [expected, found] of [['old', 'new'], ['new', 'old']])
    assert.equal(interruptConflictCandidate(new Error(`expected active turn id ${expected} but found ${found}`), 'old'), 'new');
});

test('unrelated, equal, incomplete or generic errors cannot authorize Stop recovery', () => {
  for (const error of [null, {}, new Error('Expected active turn mismatch'),
    new Error('expected active turn id other but found new'),
    new Error('expected active turn id old but found old'),
    new Error('expected active turn id old but found '),
    new Error('failure: expected active turn id old but found new')])
    assert.equal(interruptConflictCandidate(error, 'old'), null);
});

test('an uncertain Stop is never replayed even if its message resembles a conflict', () => {
  assert.equal(interruptConflictCandidate(Object.assign(new Error('expected active turn id old but found new'), { uncertain: true }), 'old'), null);
});
