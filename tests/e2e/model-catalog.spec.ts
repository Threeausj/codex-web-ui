import { test, expect, login } from './fixtures';

const family = (model: string, displayName: string, isDefault = false) => ({
  id: model, model, displayName, description: '', modelSpecialty: null, hidden: false,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault,
  serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: 'priority',
});

test('new GPT-6.2 Astra and Sol remain selectable with their family reasoning and speed controls', async ({ page, mock }) => {
  mock.modelCatalog = [
    family('gpt-6.1-sol', 'GPT-6.1-Sol', true),
    family('gpt-6-astra', 'GPT-6-Astra'),
    family('gpt-6-sol', 'GPT-6-Sol'),
  ];
  await login(page);
  const model = page.getByRole('combobox', { name: '选择模型', exact: true });
  await expect(model.locator('option[value="gpt-6.2-astra"]')).toHaveText('GPT-6.2-Astra');
  await expect(model.locator('option[value="gpt-6.2-sol"]')).toHaveText('GPT-6.2-Sol');
  await model.selectOption('gpt-6.2-astra');await expect(model).toHaveValue('gpt-6.2-astra');
  const effort = page.getByRole('combobox', { name: '推理强度', exact: true });
  await expect(effort.locator('option[value="ultra"]')).toHaveCount(1);
  const speed = page.getByRole('combobox', { name: '模型服务层级', exact: true });
  await expect(speed.locator('option[value="priority"]')).toHaveCount(1);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('验证新模型');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => mock.request('turn/start')?.params?.model).toBe('gpt-6.2-astra');
  await expect(model).toBeEnabled();
  await model.selectOption('gpt-6.2-sol');await expect(model).toHaveValue('gpt-6.2-sol');
});
