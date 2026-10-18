<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { color as oneDarkColor, oneDarkHighlightStyle, oneDarkTheme } from '@codemirror/theme-one-dark';
const props = defineProps<{ modelValue: string; path: string; readonly?: boolean; allowQuestion?: boolean; line?: number }>();
const emit = defineEmits<{
  'update:modelValue': [value: string]; save: [];
  selection: [value: { text: string; startLine: number; endLine: number }, action: 'add' | 'ask'];
}>();
const parent = ref<HTMLElement>();
const selection = ref<{ text: string; startLine: number; endLine: number } | null>(null);
const language = new Compartment(), theme = new Compartment(), editable = new Compartment();
let view: EditorView | undefined, languageGeneration = 0, observer: MutationObserver | undefined;
const dark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const darkHighlightStyle = HighlightStyle.define(oneDarkHighlightStyle.specs.map(spec => {
  if (spec.color === oneDarkColor.ivory) return { ...spec, color: 'var(--text)' };
  if (spec.color === oneDarkColor.stone) return { ...spec, color: 'var(--muted)' };
  return spec;
}));
const darkTheme = [oneDarkTheme, syntaxHighlighting(darkHighlightStyle)];
const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-content': { padding: '8px 0', minHeight: '100%', caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--text) 22%, var(--bg))' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
  '.cm-panels': { color: 'var(--text)', backgroundColor: 'var(--surface)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-foldPlaceholder': { color: 'var(--muted)', backgroundColor: 'var(--soft)', border: '1px solid var(--border)' },
  '.cm-tooltip': { color: 'var(--text)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--surface)', borderBottomColor: 'var(--surface)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: 'var(--text)', backgroundColor: 'var(--selected)' },
});
async function loadLanguage() {
  const generation = ++languageGeneration;
  const found = LanguageDescription.matchFilename(languages, props.path);
  const support = found ? await found.load().catch(() => null) : null;
  if (view && generation === languageGeneration) view.dispatch({ effects: language.reconfigure(support || []) });
}
function selected(action: 'add' | 'ask') { if (selection.value) emit('selection', { ...selection.value }, action); }
function focusLine(line: number) {
  if (!view) return;
  const target = view.state.doc.line(Math.max(1, Math.min(Math.floor(line), view.state.doc.lines)));
  view.dispatch({ selection: { anchor: target.from, head: target.to }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
  view.focus();
}
onMounted(() => {
  view = new EditorView({ parent: parent.value!, state: EditorState.create({ doc: props.modelValue, extensions: [
    basicSetup, Prec.high(baseTheme), language.of([]), theme.of(dark() ? darkTheme : []),
    editable.of([EditorState.readOnly.of(!!props.readonly), EditorView.editable.of(!props.readonly)]),
    EditorView.contentAttributes.of({ 'aria-label': `${props.path.split('/').pop()} 文件内容`, 'aria-multiline': 'true', role: 'textbox', 'aria-readonly': String(!!props.readonly), spellcheck: 'false' }),
    keymap.of([{ key: 'Mod-s', run: () => { emit('save'); return true; } }]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        selection.value = range.empty ? null : { text: update.state.sliceDoc(range.from, range.to), startLine: update.state.doc.lineAt(range.from).number, endLine: update.state.doc.lineAt(Math.max(range.from, range.to - 1)).number };
      }
    }),
  ] }) });
  void loadLanguage();
  if (props.line) focusLine(props.line);
  observer = new MutationObserver(() => view?.dispatch({ effects: theme.reconfigure(dark() ? darkTheme : []) }));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
watch(() => props.modelValue, value => {
  if (view && value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});
watch(() => props.line, value => { if (value) focusLine(value); });
watch(() => props.path, () => void loadLanguage());
watch(() => props.readonly, value => { view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(!!value), EditorView.editable.of(!value)]) }); view?.contentDOM.setAttribute('aria-readonly', String(!!value)); });
onBeforeUnmount(() => { ++languageGeneration; observer?.disconnect(); view?.destroy(); view = undefined; });
defineExpose({ focusLine });
</script>
<template>
  <div class="code-editor">
    <div ref="parent" class="code-editor-view"></div>
    <div v-if="allowQuestion" class="code-selection-toolbar" :class="{ 'has-selection': !!selection }" :aria-hidden="!selection" :inert="!selection" data-selection-ignore>
      <span>{{ selection ? `第 ${selection.startLine}–${selection.endLine} 行` : '\u00a0' }}</span>
      <button class="button button-small button-secondary" :disabled="!selection" @mousedown.prevent @click="selected('add')">添加到对话</button>
      <button class="button button-small button-secondary" :disabled="!selection" @mousedown.prevent @click="selected('ask')">在侧边聊天中提问</button>
    </div>
  </div>
</template>
<style scoped>
.code-editor { display:flex; flex-direction:column; flex:1; min-height:120px; overflow:hidden }
.code-editor-view { flex:1; min-height:0; overflow:hidden }
.code-selection-toolbar { display:flex; flex-shrink:0; align-items:center; gap:6px; min-height:44px; box-sizing:border-box; padding:6px 8px; border-top:1px solid var(--border); font-size:11px }
.code-selection-toolbar > * { visibility:hidden }
.code-selection-toolbar.has-selection > * { visibility:visible }
.code-selection-toolbar span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted) }
.code-selection-toolbar button { flex-shrink:0; min-height:30px; padding:5px 8px; font-size:11px; white-space:nowrap }
</style>
