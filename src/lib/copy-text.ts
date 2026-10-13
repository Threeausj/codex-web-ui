/** Copy also works on LAN HTTP, where the async clipboard API is unavailable. */
export async function copyText(text: string, assertCurrent: () => void = () => {}): Promise<void> {
  assertCurrent();
  if (navigator.clipboard?.writeText) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch { /* Try the user-gesture fallback before reporting a failure. */ }
    assertCurrent();
    if (copied) return;
  }
  assertCurrent();
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.append(field);
  try {
    field.focus({ preventScroll: true }); field.select();
    if (!document.execCommand('copy')) throw new Error('无法复制，请允许此网站访问剪贴板后重试');
  } finally { field.remove(); focused?.focus({ preventScroll: true }); }
}
