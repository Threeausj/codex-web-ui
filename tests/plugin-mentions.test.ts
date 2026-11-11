import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationInputs, mentionedPlugins } from '../src/lib/plugin-mentions';
import { integrationMention, validPluginId } from '../shared/plugin-mentions';

test('explicit plugin and app selections produce deduplicated native mention inputs', () => {
  const plugin=integrationMention('Documents', 'plugin://documents@openai-primary-runtime');
  assert.equal(plugin, '[@Documents](plugin://documents@openai-primary-runtime)');
  assert.deepEqual(integrationInputs(`用 ${plugin} 创建文档，再使用 [@Drive](app://drive_123)，${plugin}`), [
    {type:'mention',name:'Documents',path:'plugin://documents@openai-primary-runtime'},
    {type:'mention',name:'Drive',path:'app://drive_123'},
  ]);
  assert.equal(validPluginId('documents@openai-primary-runtime'), true);
  for (const id of ['../documents@site', 'name@site/escape', 'name@@site', 'name@site\n']) assert.equal(validPluginId(id), false);
  assert.deepEqual(integrationInputs('[@Bad](plugin://../bad@site) [@Bad](app://../../bad)'), []);
});

test('quoted references, inline code and fenced examples never activate integrations', () => {
  const mention='[@Documents](plugin://documents@openai-primary-runtime)';
  assert.deepEqual(integrationInputs(`> ${mention}\n\n\`${mention}\`\n\n\`\`\`md\n${mention}\n\`\`\`\n\n~~~md\n${mention}\n~~~`), []);
  assert.deepEqual(integrationInputs(`> ${mention}\n请实际使用 ${mention}`), [{type:'mention',name:'Documents',path:'plugin://documents@openai-primary-runtime'}]);
  assert.ok(!integrationMention('A]\\\n[恶意', 'plugin://a@site').includes('\n'));
});

test('installed bundles win over skill fallbacks while standalone skills stay in slash menu', () => {
  const installed={id:'documents@site',name:'documents',displayName:'Documents',description:'Bundle',enabled:false};
  const choices=mentionedPlugins([installed], [
    {name:'documents:edit',pluginId:'documents@site',interface:{displayName:'Editing'},enabled:true},
    {name:'presentations:slides',pluginId:'presentations@site',enabled:true},
    {name:'local-only',pluginId:null,enabled:true},
    {name:'bad',pluginId:'../../bad',enabled:true},
  ]);
  assert.equal(choices.length,2);
  assert.deepEqual(choices[0],installed);
  assert.equal(choices[1]?.id,'presentations@site');
});
