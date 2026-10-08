const interactiveMethods = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'tool/requestUserInput', 'execCommandApproval', 'applyPatchApproval',
]);
const elicitationModes = new Set(['form', 'url', 'openai/form', 'openaiForm', 'openai/userVerification']);

/** A server RPC is not necessarily a request for a person's decision. */
export function isInteractiveServerRequest(message: { id?: unknown; method?: string; params?: any }): boolean {
  return message.id !== undefined && (interactiveMethods.has(message.method || '') ||
    message.method === 'mcpServer/elicitation/request' && elicitationModes.has(message.params?.mode));
}
