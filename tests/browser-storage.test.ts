import test from 'node:test';
import assert from 'node:assert/strict';
import { ResilientStorage } from '../src/lib/browser-storage';

test('denied storage does not throw; failed replacements and deletions mask stale saved drafts until recovery', () => {
  let denied = false;
  const values = new Map<string, string>([['draft', 'Old saved draft']]);
  const storage = new ResilientStorage(() => ({
    getItem(key: string) { if (denied) throw new Error('Denied'); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (denied) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem(key: string) { if (denied) throw new Error('Denied'); values.delete(key); },
  }) as Storage);
  assert.equal(storage.getItem('draft'), 'Old saved draft');
  denied = true;
  assert.equal(storage.setItem('draft', 'New unsaved draft'), false);
  assert.equal(storage.getItem('draft'), 'New unsaved draft');
  assert.equal(storage.isTemporary('draft'), true);
  assert.equal(storage.removeItem('draft'), false);
  denied = false;
  assert.equal(storage.getItem('draft'), null, 'A failed deletion must not resurrect the submitted draft');
  assert.equal(storage.setItem('draft', 'Recovered draft'), true);
  assert.equal(storage.isTemporary('draft'), false);
  assert.equal(values.get('draft'), 'Recovered draft');
});

test('a blocked storage getter permits current-window values without requiring global storage at module load', () => {
  const storage = new ResilientStorage(() => { throw new Error('SecurityError'); });
  assert.equal(storage.getItem('missing'), null);
  assert.equal(storage.setItem('clientId', 'window-client'), false);
  assert.equal(storage.getItem('clientId'), 'window-client');
  assert.equal(storage.removeItem('clientId'), false);
  assert.equal(storage.getItem('clientId'), null);
});
