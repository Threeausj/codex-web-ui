<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder as editorPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { markdownLivePreview } from '../lib/markdown-live-preview';

const props = withDefaults(defineProps<{
  modelValue: string; placeholder?: string; disabled?: boolean; sourceMode?: boolean; historyScope?: string;
  ariaControls?: string; ariaExpanded?: boolean; ariaActivedescendant?: string;
}>(), { placeholder: '', disabled: false, sourceMode: false });
const emit = defineEmits<{
  'update:modelValue': [value: string]; input: []; 'selection-change': [];
  keydown: [event: KeyboardEvent]; paste: [event: ClipboardEvent];
  beforeinput: [event: InputEvent]; click: [event: MouseEvent];
}>();
const parent = ref<HTMLElement>();
const editable = new Compartment(), preview = new Compartment(), prompt = new Compartment(), aria = new Compartment();
let view: EditorView | undefined;
let syncFromParent = false;
let compositionRefresh: number | undefined;
function guardCompositionKey(event: KeyboardEvent) {
  if (view && (event.isComposing || event.keyCode === 229 || view.composing || view.compositionStarted && event.key === 'Enter')) {
    // Stop the editor/chat keymaps, but leave the browser's native IME
    // confirmation untouched. Returning true from a CM handler would also
    // preventDefault and can block committing a candidate on mobile.
    event.stopImmediatePropagation();
  }
}
const attributes = () => ({ role: 'textbox', 'aria-label': '消息输入框', 'aria-multiline': 'true',
  'aria-readonly': String(props.disabled), 'aria-disabled': String(props.disabled), 'aria-autocomplete': 'list',
  ...(props.ariaControls ? { 'aria-controls': props.ariaControls } : {}),
  'aria-expanded': String(!!props.ariaExpanded),
  ...(props.ariaActivedescendant ? { 'aria-activedescendant': props.ariaActivedescendant } : {}),
  spellcheck: 'false', autocapitalize: 'sentences', enterkeyhint: 'enter' });

function focus(options?: FocusOptions) {
  if (!view || props.disabled) return;
  if (options?.preventScroll) view.contentDOM.focus(options);
  else view.focus();
}
function setSelectionRange(start: number, end = start, direction?: 'forward' | 'backward' | 'none') {
  if (!view) return;
  const length = view.state.doc.length;
  const from = Math.max(0, Math.min(length, start)), to = Math.max(from, Math.min(length, end));
  view.dispatch({ selection: EditorSelection.single(direction === 'backward' ? to : from, direction === 'backward' ? from : to) });
}
function replaceSelection(from: number, to: number, text: string, selection?: { start: number; end: number }) {
  if (!view || props.disabled) return;
  const length = view.state.doc.length;
  from = Math.max(0, Math.min(length, from)); to = Math.max(from, Math.min(length, to));
  const cursor = from + text.length;
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.single(selection?.start ?? cursor, selection?.end ?? cursor),
    scrollIntoView: true, annotations: [Transaction.userEvent.of('input.format'), isolateHistory.of('full')] });
}
function resize() { view?.requestMeasure(); }
function editorState(value: string) {
  return EditorState.create({ doc: value, selection: EditorSelection.cursor(value.length), extensions: [
    history(), drawSelection(), EditorView.lineWrapping,
    markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
    editable.of([EditorState.readOnly.of(props.disabled), EditorView.editable.of(!props.disabled)]),
    preview.of(props.sourceMode ? [] : markdownLivePreview()),
    prompt.of(editorPlaceholder(props.placeholder)), aria.of(EditorView.contentAttributes.of(attributes())),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, editor) {
        if (editor.composing || event.isComposing || event.keyCode === 229) return false;
        emit('keydown', event); return event.defaultPrevented;
      },
      paste(event) { emit('paste', event); return event.defaultPrevented; },
      drop(event) {
        if (!event.dataTransfer?.files.length) return false;
        // Attachments belong to the composer's upload handler. CodeMirror's
        // default drop handler would also read their contents into the draft.
        // Leave bubbling intact so the surrounding composer uploads them once.
        event.preventDefault(); return true;
      },
      beforeinput(event: InputEvent, editor) {
        if (editor.composing || event.isComposing || /composition/i.test(event.inputType)) return false;
        emit('beforeinput', event); return event.defaultPrevented;
      },
      click(event) { emit('click', event); return false; },
      compositionend() {
        if (compositionRefresh !== undefined) cancelAnimationFrame(compositionRefresh);
        compositionRefresh = requestAnimationFrame(() => {
          compositionRefresh = undefined;
          if (view && !view.composing) view.dispatch({ effects: preview.reconfigure(props.sourceMode ? [] : markdownLivePreview()) });
        });
        return false;
      },
    })),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !syncFromParent) { emit('update:modelValue', update.state.doc.toString()); emit('input'); }
      if (update.selectionSet) emit('selection-change');
    }),
  ] });
}
onMounted(() => {
  view = new EditorView({ parent: parent.value!, state: editorState(props.modelValue) });
  view.contentDOM.addEventListener('keydown', guardCompositionKey, true);
});
watch(() => [props.historyScope, props.modelValue] as const, ([scope, value], [previousScope]) => {
  if (!view) return;
  if (scope !== previousScope) {
    const focused = view.hasFocus;
    // History belongs to the draft identity, not this reusable DOM component.
    // An Undo in a new host/thread must never restore another draft's text.
    view.setState(editorState(value));
    if (focused && !props.disabled) focus({ preventScroll: true });
    return;
  }
  if (view.state.doc.toString() === value) return;
  syncFromParent = true;
  try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
    annotations: Transaction.addToHistory.of(false) }); }
  finally { syncFromParent = false; }
});
watch(() => props.sourceMode, source => { view?.dispatch({ effects: preview.reconfigure(source ? [] : markdownLivePreview()) }); });
watch(() => props.placeholder, value => { view?.dispatch({ effects: prompt.reconfigure(editorPlaceholder(value)) }); });
watch(() => props.disabled, value => { view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) }); });
watch(() => [props.disabled, props.ariaControls, props.ariaExpanded, props.ariaActivedescendant], () => {
  view?.dispatch({ effects: aria.reconfigure(EditorView.contentAttributes.of(attributes())) });
});
onBeforeUnmount(() => {
  if (compositionRefresh !== undefined) cancelAnimationFrame(compositionRefresh);
  view?.contentDOM.removeEventListener('keydown', guardCompositionKey, true);
  view?.destroy(); view = undefined;
});
defineExpose({ focus, setSelectionRange, replaceSelection, resize,
  get value() { return view?.state.doc.toString() ?? props.modelValue; },
  get selectionStart() { return view?.state.selection.main.from ?? 0; },
  get selectionEnd() { return view?.state.selection.main.to ?? 0; },
  get contentDOM() { return view?.contentDOM; },
  get composing() { return !!(view?.composing || view?.compositionStarted); },
});
</script>

<template><div ref="parent" class="markdown-composer-editor" :class="{ 'is-disabled': disabled, 'markdown-source-mode': sourceMode }"></div></template>

<style scoped>
.markdown-composer-editor { --composer-editor-font-size:14px;width:100%;min-width:0;padding:0 2px 8px; }
.markdown-composer-editor :deep(.cm-editor) { background:transparent;color:var(--text);font-family:inherit;font-size:14px; }
.markdown-composer-editor :deep(.cm-editor.cm-focused) { outline:none; }
.markdown-composer-editor :deep(.cm-scroller) { min-height:51px;max-height:210px;overflow:auto;font:inherit;line-height:1.8;overscroll-behavior:contain; }
.markdown-composer-editor :deep(.cm-content) { min-height:51px;padding:0;caret-color:var(--text);font-family:inherit;overflow-wrap:anywhere; }
.markdown-composer-editor :deep(.cm-line) { padding:0; }
.markdown-composer-editor :deep(.cm-cursor) { border-left-color:var(--text); }
.markdown-composer-editor :deep(.cm-selectionBackground),.markdown-composer-editor :deep(.cm-focused .cm-selectionBackground) { background:var(--selection,var(--selected)); }
.markdown-composer-editor :deep(.cm-placeholder) { color:var(--muted); }
.markdown-composer-editor.is-disabled { opacity:.65; }
.markdown-composer-editor :deep(.cm-md-heading) { font-weight:650;line-height:1.65; }
.markdown-composer-editor :deep(.cm-md-heading-1) { font-size:1.3em; }
.markdown-composer-editor :deep(.cm-md-heading-2) { font-size:1.2em; }
.markdown-composer-editor :deep(.cm-md-heading-3) { font-size:1.1em; }
.markdown-composer-editor :deep(.cm-md-strong) { font-weight:700; }
.markdown-composer-editor :deep(.cm-md-emphasis) { font-style:italic; }
.markdown-composer-editor :deep(.cm-md-strike) { text-decoration:line-through; }
.markdown-composer-editor :deep(.cm-md-inline-code) { font-family:var(--font-mono,monospace);font-size:.92em;background:var(--soft);border-radius:3px; }
.markdown-composer-editor :deep(.cm-md-code-block) { font-family:var(--font-mono,monospace);font-size:.92em;background:var(--soft);padding-left:8px;border-left:2px solid var(--border); }
.markdown-composer-editor :deep(.cm-md-quote) { color:var(--muted);border-left:2px solid var(--border);padding-left:9px; }
.markdown-composer-editor :deep(.cm-md-link) { color:var(--accent-text,var(--info));text-decoration:underline;text-underline-offset:2px; }
.markdown-composer-editor :deep(.cm-md-source-token) { color:var(--muted);font-weight:400;opacity:.68; }
.markdown-composer-editor :deep(.cm-md-hidden-token) { font-size:0;line-height:0; }
.markdown-composer-editor :deep(.cm-md-preview-token::after) { content:attr(data-preview-token);font-size:var(--composer-editor-font-size);line-height:1.8; }
.markdown-composer-editor :deep(.cm-md-list-bullet),.markdown-composer-editor :deep(.cm-md-list-number) { color:var(--muted);font-weight:500; }
.markdown-composer-editor :deep(.cm-md-task-marker) { color:var(--accent-text,var(--info));font-family:inherit; }
.markdown-composer-editor :deep(.cm-md-image-placeholder) { display:inline-block;max-width:100%;padding:0 5px;border:1px solid var(--border);border-radius:4px;color:var(--muted); }
.markdown-composer-editor :deep(.cm-md-image-placeholder::after) { font-size:calc(var(--composer-editor-font-size) * .9); }
.markdown-composer-editor :deep(.cm-md-rule) { position:relative; }
.markdown-composer-editor :deep(.cm-md-rule-source) { color:transparent; }
.markdown-composer-editor :deep(.cm-md-rule::after) { position:absolute;content:'';height:1px;background:var(--border);left:0;right:0;top:50%;pointer-events:none; }
@media(max-width:760px) { .markdown-composer-editor { --composer-editor-font-size:16px; }.markdown-composer-editor :deep(.cm-editor) { font-size:16px; }.markdown-composer-editor :deep(.cm-scroller) { max-height:min(210px,35dvh); } }
</style>
