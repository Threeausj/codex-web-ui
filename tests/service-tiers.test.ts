import test from 'node:test';
import assert from 'node:assert/strict';
import { modelServiceTiers, serviceTierParams, serviceTierScope, rateLimitWindows } from '../src/lib/service-tiers';

test('only service tiers advertised by the current model can override a thread or new-thread scope', () => {
  const state: any = { hostId: 'nas', activeThread: { id: 'conversation-a' }, projectPath: '/work', model: 'model-a', models: [{ model: 'model-a', serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Native catalog' }] }] };
  assert.deepEqual(serviceTierParams(state), {});
  state.serviceTierScope = serviceTierScope(state); state.serviceTier = 'fast';
  assert.deepEqual(serviceTierParams(state), { serviceTier: 'fast' });
  state.activeThread = { id: 'conversation-b' };
  assert.deepEqual(serviceTierParams(state), {}, 'Another conversation must preserve its own native tier');
  state.serviceTierScope = serviceTierScope(state); state.serviceTier = 'invented-tier';
  assert.deepEqual(serviceTierParams(state), {});
  state.serviceTier = null; assert.deepEqual(serviceTierParams(state), { serviceTier: null });
  state.model = 'gateway-model'; assert.deepEqual(modelServiceTiers(state), []); assert.deepEqual(serviceTierParams(state), {});
});

test('account quota windows show backend usage and reset times without inventing unavailable metadata', () => {
  assert.deepEqual(rateLimitWindows({}), []);
  const windows = rateLimitWindows({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 63.4, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } } } });
  assert.equal(windows.length, 2); assert.equal(windows[0].label, '5 小时'); assert.equal(windows[0].resetsAt, 1700000000000); assert.equal(windows[1].label, '7 天'); assert.equal(windows[1].resetsAt, null);
});
