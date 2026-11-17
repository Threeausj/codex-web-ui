import test from 'node:test';
import assert from 'node:assert/strict';
import { extendModelCatalog } from '../src/lib/model-catalog';

const catalog = () => [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
  { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6-Sol', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'max' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
];

test('exposes GPT-6.2 Astra and Sol from the available native family metadata', () => {
  const original = catalog(), result = extendModelCatalog(original);
  assert.deepEqual(result.map(model => model.model), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.2-astra', 'gpt-6.2-sol']);
  const astra = result.find(model => model.model === 'gpt-6.2-astra')!;
  assert.equal(astra.displayName, 'GPT-6.2-Astra');assert.equal(astra.isDefault, false);
  assert.deepEqual(astra.supportedReasoningEfforts, original[1]!.supportedReasoningEfforts);
  assert.deepEqual(astra.serviceTiers, original[1]!.serviceTiers);
  assert.equal(original.length, 3);assert.equal(original[1]!.model, 'gpt-6-astra');
});

test('preserves native 6.2 metadata and avoids duplicate entries', () => {
  const original = [...catalog(), { id: 'native-astra', model: 'gpt-6.2-astra', displayName: 'Astra 6.2 native', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  const result = extendModelCatalog(original);
  assert.equal(result.filter(model => model.model === 'gpt-6.2-astra').length, 1);
  assert.equal(result.find(model => model.model === 'gpt-6.2-astra')?.displayName, 'Astra 6.2 native');
  assert.ok(result.some(model => model.model === 'gpt-6.2-sol'));
});

test('does not advertise a model family missing from the current host catalog', () => {
  assert.deepEqual(extendModelCatalog([{ model: 'gpt-6.1-sol', displayName: 'Sol' }]).map(model => model.model), ['gpt-6.1-sol']);
  assert.deepEqual(extendModelCatalog([{ model: 'gpt-6-astra', displayName: 'Astra', hidden: true }]), [{ model: 'gpt-6-astra', displayName: 'Astra', hidden: true }]);
});
