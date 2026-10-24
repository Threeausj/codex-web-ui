import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** This view never parses HTML or creates remotely loaded resources. The
 * underlying document remains ordinary Markdown for copying and sending. */
const inlineStyles: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong', Emphasis: 'cm-md-emphasis', Strikethrough: 'cm-md-strike', InlineCode: 'cm-md-inline-code',
};
const tokenStyles = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'QuoteMark', 'LinkMark']);

function decorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const state = view.state;
  const seen = new Set<string>();
  const lineClasses = new Map<number, Set<string>>();
  const selection = state.selection;
  const editing = (from: number, to: number) => view.hasFocus && selection.ranges.some(range =>
    range.empty ? range.head >= from && range.head <= to : range.from <= to && range.to >= from);
  const add = (from: number, to: number, decoration: Decoration, identity: string) => {
    if (from >= to || seen.has(identity)) return;
    seen.add(identity); ranges.push(decoration.range(from, to));
  };
  const mark = (from: number, to: number, className: string) => add(from, to, Decoration.mark({ class: className }), `m:${from}:${to}:${className}`);
  // Zero-size marks retain the actual Markdown text nodes for native copy,
  // accessibility and editor position mapping. CSS renders optional safe
  // token labels; it never substitutes HTML or downloads document resources.
  const hide = (from: number, to: number, token?: { text: string; className: string }) => add(from, to,
    Decoration.mark({ class: `cm-md-hidden-token${token ? ` cm-md-preview-token ${token.className}` : ''}`,
      ...(token ? { attributes: { 'data-preview-token': token.text } } : {}) }), `r:${from}:${to}`);
  const line = (position: number, className: string) => {
    const start = state.doc.lineAt(position).from;
    const classes = lineClasses.get(start) || new Set<string>();
    classes.add(className); lineClasses.set(start, classes);
  };
  const tree = syntaxTree(state);
  for (const visible of view.visibleRanges) tree.iterate({
    from: visible.from, to: visible.to,
    enter(node) {
      const { from, to, name } = node;
      const parent = node.node.parent;
      const active = editing(parent?.from ?? from, parent?.to ?? to);
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) line(from, `cm-md-heading cm-md-heading-${heading[1]}`);
      if (inlineStyles[name]) mark(from, to, inlineStyles[name]);
      if (name === 'Link') mark(from, to, 'cm-md-link');
      if (name === 'Blockquote') {
        const first = state.doc.lineAt(Math.max(from, visible.from));
        const last = state.doc.lineAt(Math.min(to, visible.to));
        for (let number = first.number; number <= last.number; number++) line(state.doc.line(number).from, 'cm-md-quote');
      }
      if (name === 'ListItem') line(from, 'cm-md-list');
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = state.doc.lineAt(Math.max(from, visible.from));
        const last = state.doc.lineAt(Math.min(to, visible.to));
        for (let number = first.number; number <= last.number; number++) line(state.doc.line(number).from, 'cm-md-code-block');
      }
      if (name === 'HorizontalRule') {
        line(from, 'cm-md-rule');
        // Preserve the source width/caret when the rule is being edited.
        if (!editing(from, to)) mark(from, to, 'cm-md-rule-source');
      }
      if (name === 'Image') {
        if (!editing(from, to) && !state.sliceDoc(from, to).includes('\n')) {
          const source = state.sliceDoc(from, to);
          const alt = /^!\[([^\]]*)\]/.exec(source)?.[1] || '图片';
          hide(from, to, { text: `▧ ${alt}`, className: 'cm-md-image-placeholder' });
          return false;
        }
        mark(from, to, 'cm-md-source-token');
      }
      if (name === 'ListMark') {
        const text = state.sliceDoc(from, to);
        if (editing(parent?.from ?? from, parent?.to ?? to)) mark(from, to, 'cm-md-source-token');
        else if (/^[*+-]$/.test(text)) hide(from, to, { text: '•', className: 'cm-md-list-bullet' });
        else mark(from, to, 'cm-md-list-number');
      }
      if (name === 'TaskMarker') {
        if (active) mark(from, to, 'cm-md-source-token');
        else hide(from, to, { text: /[xX]/.test(state.sliceDoc(from, to)) ? '☑' : '☐', className: 'cm-md-task-marker' });
      }
      if (tokenStyles.has(name)) {
        // A fenced block's delimiters stay as subtle labels rather than
        // removing whole lines, so line geometry and cursor mapping remain stable.
        const fenced = parent?.name === 'FencedCode';
        if (active || fenced || name === 'HeaderMark' && parent?.name.startsWith('Setext')) mark(from, to, 'cm-md-source-token');
        else hide(from, to);
      }
      if (name === 'URL' && parent?.name === 'Link') {
        if (active) mark(from, to, 'cm-md-source-token');
        else hide(from, to);
      }
      if (name === 'CodeInfo') mark(from, to, 'cm-md-source-token');
    },
  });
  for (const [position, classes] of lineClasses) ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(position));
  return Decoration.set(ranges, true);
}

/** Only marks and line styles are produced; viewport-derived decorations never
 * replace line breaks or introduce block widgets. */
export function markdownLivePreview(): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view); }
    update(update: ViewUpdate) {
      if (update.view.composing) {
        // Keep the composition DOM and marker geometry stable while an IME is
        // replacing its provisional text. Rebuild after composition ends.
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = decorations(update.view);
    }
  }, { decorations: value => value.decorations });
}
