import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { randomUUID } from './uuid';

type Panel = { id: string; visible(): boolean; close(): void };
const marker = 'codexMobilePanel';

/** Browser Back (including Android's edge gesture) dismisses mobile panels. */
export function useMobilePanelBack(authenticated: () => boolean, panels: Panel[]) {
  const query = window.matchMedia('(max-width: 760px)');
  const mobile = ref(query.matches);
  const token = randomUUID();
  let stack: string[] = [], armed = false, removing = false, handling = false;
  const ownsEntry = () => history.state?.[marker] === token;
  const enabled = () => mobile.value && authenticated();
  const openPanels = () => enabled() ? panels.filter(panel => panel.visible()).map(panel => panel.id) : [];
  const baseState = () => {
    const value = history.state && typeof history.state === 'object' ? { ...history.state } : {};
    delete value[marker]; return value;
  };
  function reconcile() {
    const open = openPanels();
    stack = [...stack.filter(id => open.includes(id)), ...open.filter(id => !stack.includes(id))];
    if (removing || handling) return;
    if (stack.length && !ownsEntry()) {
      history.pushState({ ...baseState(), [marker]: token }, '', location.href);
      armed = true;
    } else if (!stack.length && ownsEntry()) {
      // Consume our own entry on button/backdrop closure as well. A close
      // followed immediately by another open waits for this traversal.
      removing = true; history.back();
    }
  }
  function onPopState() {
    if (removing) {
      removing = false; armed = false; reconcile(); return;
    }
    if (ownsEntry()) {
      // Forward into a dismissed panel entry must not resurrect the panel.
      if (!openPanels().length) history.replaceState(baseState(), '', location.href);
      else armed = true;
      return;
    }
    const close = armed && enabled() ? panels.find(panel => panel.id === stack.at(-1) && panel.visible()) : undefined;
    armed = false; handling = true;
    try { close?.close(); } finally { handling = false; reconcile(); }
  }
  const resized = () => { mobile.value = query.matches; };
  const stop = watch(() => [enabled(), ...panels.map(panel => panel.visible())], reconcile, { flush: 'post' });
  onMounted(() => {
    window.addEventListener('popstate', onPopState);
    query.addEventListener('change', resized);
    // A full reload starts with closed panels; discard a previous renderer's
    // marker without navigating away from the newly restored conversation.
    if (history.state?.[marker] && !ownsEntry()) history.replaceState(baseState(), '', location.href);
    reconcile();
  });
  onBeforeUnmount(() => {
    stop(); window.removeEventListener('popstate', onPopState);
    query.removeEventListener('change', resized);
    if (ownsEntry()) history.replaceState(baseState(), '', location.href);
  });
}
