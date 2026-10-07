<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
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
const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-content': { padding: '8px 0', minHeight: '100%' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--text) 8%, transparent)' },
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
    basicSetup, baseTheme, language.of([]), theme.of(dark() ? oneDark : []),
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
  observer = new MutationObserver(() => view?.dispatch({ effects: theme.reconfigure(dark() ? oneDark : []) }));
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
    <div v-if="selection && allowQuestion" class="code-selection-toolbar" data-selection-ignore>
      <span>第 {{ selection.startLine }}–{{ selection.endLine }} 行</span>
      <button class="button button-small button-secondary" @mousedown.prevent @click="selected('add')">添加到对话</button>
      <button class="button button-small button-secondary" @mousedown.prevent @click="selected('ask')">在侧边聊天中提问</button>
    </div>
    <div ref="parent" class="code-editor-view"></div>
  </div>
</template>
<style scoped>
.code-editor { display:flex; flex-direction:column; flex:1; min-height:120px; overflow:hidden }
.code-editor-view { flex:1; min-height:0; overflow:hidden }
.code-selection-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--border); font-size:11px }
.code-selection-toolbar span { margin-right:auto; color:var(--muted) }
</style>
