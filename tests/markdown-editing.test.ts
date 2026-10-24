import assert from 'node:assert/strict';
import test from 'node:test';
import { continueMarkdown, formatMarkdown, isMarkdownCodeAt } from '../src/lib/markdown-editing';

const selection = (start: number, end = start) => ({ start, end });
const cursor = (text: string) => selection(text.length);

test('bold shortcuts wrap the selection, toggle either selection convention, and retain surrounding text', () => {
  assert.deepEqual(formatMarkdown('前中文后', selection(1, 3), 'bold'), {
    text: '前**中文**后', selection: selection(3, 5), handled: true,
  });
  assert.equal(formatMarkdown('前**中文**后', selection(3, 5), 'bold').text, '前中文后');
  assert.equal(formatMarkdown('前**中文**后', selection(1, 7), 'bold').text, '前中文后');
  assert.deepEqual(formatMarkdown('草稿', selection(1), 'bold'), {
    text: '草****稿', selection: selection(3), handled: true,
  });
  assert.equal(formatMarkdown('草****稿', selection(3), 'bold').text, '草稿');
  assert.equal(formatMarkdown('  加粗  ', selection(0, 6), 'bold').text, '  **加粗**  ');
});

test('italic remains independent of bold, including combined emphasis', () => {
  assert.equal(formatMarkdown('**中文**', selection(2, 4), 'italic').text, '***中文***');
  assert.equal(formatMarkdown('***中文***', selection(3, 5), 'italic').text, '**中文**');
  assert.equal(formatMarkdown('***中文***', selection(0, 8), 'italic').text, '**中文**');
  assert.equal(formatMarkdown('***中文***', selection(3, 5), 'bold').text, '*中文*');
});

test('inline code chooses a delimiter which keeps literal backticks and supports toggling', () => {
  const text = '前value`尾';
  const edit = formatMarkdown(text, selection(1, text.length), 'code');
  assert.equal(edit.text, '前``value`尾``');
  assert.equal(edit.text.slice(edit.selection.start, edit.selection.end), 'value`尾');
  assert.equal(formatMarkdown(edit.text, edit.selection, 'code').text, text);
  const backticks = formatMarkdown('`字`', selection(0, 3), 'code');
  assert.equal(backticks.text, '字');
  assert.equal(formatMarkdown('x`', selection(1, 2), 'code').text, 'x`` ` ``');
});

test('link shortcut selects an editable destination and can remove an existing link without losing its label', () => {
  const linked = formatMarkdown('前中文后', selection(1, 3), 'link');
  assert.equal(linked.text, '前[中文](https://)后');
  assert.equal(linked.text.slice(linked.selection.start, linked.selection.end), 'https://');
  assert.equal(formatMarkdown(linked.text, selection(2, 4), 'link').text, '前中文后');
  const fullLink = '[链接](https://example.invalid)';
  assert.equal(formatMarkdown(fullLink, selection(0, fullLink.length), 'link').text, '链接');
  const empty = formatMarkdown('', selection(0), 'link');
  assert.equal(empty.text.slice(empty.selection.start, empty.selection.end), '链接文字');
});

test('offsets preserve emoji, non-BMP characters, reversed selections, and out-of-range input', () => {
  const text = '前😀中𠮷后';
  const edit = formatMarkdown(text, selection(6, 1), 'bold');
  assert.equal(edit.text, '前**😀中𠮷**后');
  assert.equal(edit.text.slice(edit.selection.start, edit.selection.end), '😀中𠮷');
  assert.equal(formatMarkdown('文字', selection(-100, 1000), 'italic').text, '*文字*');
  assert.equal(formatMarkdown('文字', selection(NaN, NaN), 'bold').selection.start, 4);
});

test('Enter continues unordered, ordered, indented and checked task lists', () => {
  for (const [source, expected] of [
    ['- 第一项', '- 第一项\n- '], ['* 项目', '* 项目\n* '], ['+ 项目', '+ 项目\n+ '],
    ['9. 项目', '9. 项目\n10. '], ['02) 项目', '02) 项目\n03) '],
    ['  - 子项', '  - 子项\n  - '], ['\t- 子项', '\t- 子项\n\t- '],
    ['- [x] 已完成', '- [x] 已完成\n- [ ] '], ['- [X] 已完成', '- [X] 已完成\n- [ ] '],
  ]) {
    const edit = continueMarkdown(source, cursor(source));
    assert.equal(edit.text, expected);
    assert.deepEqual(edit.selection, cursor(expected));
    assert.equal(edit.handled, true);
  }
});

test('Enter splits a list at the caret and replaces its selected text without changing later lines', () => {
  assert.deepEqual(continueMarkdown('- 中文😀尾\n后文', selection(4, 6)), {
    text: '- 中文\n- 尾\n后文', selection: selection(7), handled: true,
  });
  assert.equal(continueMarkdown('- 首尾', selection(3)).text, '- 首\n- 尾');
  assert.equal(continueMarkdown('- 首尾', selection(0)).text, '\n- 首尾');
});

test('empty items exit their list while preserving a containing quote or indentation', () => {
  for (const [source, expected] of [
    ['- 前项\n- ', '- 前项\n'], ['1. ', ''], ['- [ ]', ''], ['- [x]  ', ''],
    ['  - ', '  '], ['> - ', '> '], ['> > ', '> '], ['> ', ''],
  ]) {
    const edit = continueMarkdown(source, cursor(source));
    assert.equal(edit.text, expected);
    assert.deepEqual(edit.selection, cursor(expected));
    assert.equal(edit.handled, true);
  }
});

test('quote continuation preserves nested quote/list structure and resets task state', () => {
  assert.equal(continueMarkdown('> 引用', cursor('> 引用')).text, '> 引用\n> ');
  assert.equal(continueMarkdown('> > 引用', cursor('> > 引用')).text, '> > 引用\n> > ');
  assert.equal(continueMarkdown('>   - [x] 子项', cursor('>   - [x] 子项')).text, '>   - [x] 子项\n>   - [ ] ');
});

test('plain text, multiline selections and fenced code do not consume the caller’s Enter policy', () => {
  for (const text of ['普通正文', '-没有空格', '```md\n- 代码', '~~~\n1. 代码', '> ```md\n> - 代码', '- ```md\n  - literal', '    - ```md\n      1. literal']) {
    assert.equal(continueMarkdown(text, cursor(text)).handled, false);
    assert.equal(continueMarkdown(text, cursor(text)).text, text);
  }
  assert.equal(continueMarkdown('- 第一项\n- 第二项', selection(2, 9)).handled, false);
  const afterCode = '```\n- literal\n```\n- 正文';
  assert.equal(continueMarkdown(afterCode, cursor(afterCode)).text, afterCode + '\n- ');
  const longerFence = '````\n```\n- literal';
  assert.equal(continueMarkdown(longerFence, cursor(longerFence)).handled, false);
  const afterNestedCode = '    - ```md\n      - literal\n      ```\n    - 正文';
  assert.equal(continueMarkdown(afterNestedCode, cursor(afterNestedCode)).text, afterNestedCode + '\n    - ');
});

test('list edits preserve Windows line endings and large literal code selections stay linear', () => {
  const windows = '- 第一项\r\n- 第二项';
  assert.equal(continueMarkdown(windows, cursor(windows)).text, windows + '\r\n- ');
  const literal = '`a'.repeat(100_000);
  const edit = formatMarkdown(literal, selection(0, literal.length), 'code');
  assert.equal(edit.text.slice(edit.selection.start, edit.selection.end), literal);
  assert.equal(edit.text.startsWith('`` '), true);
});

test('fenced code detection follows the caret, nested container indentation and the matching closing fence', () => {
  const text = '前文\n```ts\n- literal\n```\n后文';
  assert.equal(isMarkdownCodeAt(text, 0), false);
  assert.equal(isMarkdownCodeAt(text, text.indexOf('- literal')), true);
  assert.equal(isMarkdownCodeAt(text, text.lastIndexOf('```')), true);
  assert.equal(isMarkdownCodeAt(text, text.lastIndexOf('```') + 3), false);
  assert.equal(isMarkdownCodeAt(text, text.length), false);
  const nested = '>   - ~~~~md\n>     - literal\n>     ~~~\n>     more';
  assert.equal(isMarkdownCodeAt(nested, nested.length), true, 'a shorter fence does not close a nested block');
  assert.equal(isMarkdownCodeAt(nested + '\n>     ~~~~', nested.length + 11), false);
  assert.equal(isMarkdownCodeAt('```md\n- literal', -20), false);
  assert.equal(isMarkdownCodeAt('```md\n- literal', NaN), true);
});
