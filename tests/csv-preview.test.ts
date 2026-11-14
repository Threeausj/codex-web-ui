import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, decodeCsvBytes, isCsvPath } from '../src/lib/csv-preview';

test('CSV preserves quoted commas, escaped quotes, multiline fields, empty cells and CRLF', () => {
  const data = parseCsv('\uFEFF姓名,说明,空列\r\n张三,"第一行\r\n第二行, ""原文""",\r\n李四,,0\r\n');
  assert.deepEqual(data.rows, [['姓名', '说明', '空列'], ['张三', '第一行\r\n第二行, "原文"', ''], ['李四', '', '0']]);
  assert.equal(data.columns, 3);assert.equal(data.truncated, false);assert.equal(data.warning, '');
});
test('delimiter detection ignores punctuation inside quotes and supports Excel semicolon and TSV', () => {
  assert.equal(parseCsv('姓名;备注;值\n甲;"多个,逗号,在,引号里";1\n乙;普通;2').delimiter, ';');
  assert.deepEqual(parseCsv('姓名\t值\n甲\t1\n乙\t2').rows, [['姓名', '值'], ['甲', '1'], ['乙', '2']]);
  assert.equal(parseCsv('"hello,world"').columns, 1);
  assert.deepEqual(parseCsv('a;b', ',').rows, [['a;b']]);
});
test('CSV leaves HTML and spreadsheet formulas as literal data and tolerates malformed input with a warning', () => {
  assert.deepEqual(parseCsv('<script>alert(1)</script>,=HYPERLINK("x")').rows[0], ['<script>alert(1)</script>', '=HYPERLINK("x")']);
  assert.match(parseCsv('a,b\n"unclosed').warning, /引号/);
  assert.match(parseCsv('a,b\n"quoted"extra,c').warning, /引号/);
  assert.deepEqual(parseCsv('').rows, []);assert.deepEqual(parseCsv('""').rows, [['']]);
});
test('preview bounds stop before retaining unbounded rows, columns or a huge cell', () => {
  const data = parseCsv('a,b\n1,2\n3,4\n5,6', undefined, { rows: 2, cells: 100 });
  assert.equal(data.rows.length, 2);assert.equal(data.truncated, true);
  assert.equal(parseCsv('x'.repeat(1048578)).truncated, true);
  assert.equal(parseCsv(Array(10002).fill('x').join(',')).truncated, true);
  assert.throws(() => parseCsv('x', '|'));
});
test('CSV encoding supports UTF-8, UTF-16 Excel exports and legacy Chinese GB18030', () => {
  const utf8 = decodeCsvBytes(new TextEncoder().encode('姓名,值\n甲,1'));
  assert.equal(utf8.encoding, 'UTF-8');assert.match(utf8.content, /姓名/);
  const le = decodeCsvBytes(Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from('姓名,值\n甲,1', 'utf16le')]));
  assert.equal(le.encoding, 'UTF-16LE');assert.equal(le.content, utf8.content);
  const be = Buffer.from(Buffer.from('姓名,值\n甲,1', 'utf16le')).swap16();
  assert.equal(decodeCsvBytes(Buffer.concat([Buffer.from([0xfe,0xff]), be])).content, utf8.content);
  const gb = decodeCsvBytes(Uint8Array.from([0xd6,0xd0,0xce,0xc4,0x2c,0x31]));
  assert.equal(gb.content, '中文,1');assert.equal(gb.encoding, 'GB18030');
  assert.equal(isCsvPath('/目录/数据.CSV'), true);assert.equal(isCsvPath('tab.tsv'), true);assert.equal(isCsvPath('report.xlsx'), false);
  assert.throws(() => decodeCsvBytes(new Uint8Array([0, 1, 2])));
});
