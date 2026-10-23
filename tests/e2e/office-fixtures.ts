import Zip from 'jszip';
import * as XLSX from '@stackline/xlsx';

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relationships = (inner: string) => declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + inner + '</Relationships>';
export async function docxFixture() {
  const zip = new Zip();
  zip.file('[Content_Types].xml', declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', relationships('<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'));
  zip.file('word/_rels/document.xml.rels', relationships('<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://office-private-preview.invalid/track" TargetMode="External"/>'));
  zip.file('word/document.xml', declaration + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>中文工作文档 · 第一页</w:t></w:r></w:p><w:p><w:hyperlink r:id="external"><w:r><w:t>外部链接不会打开</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:br w:type="page"/><w:t>第二页的独立内容</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>');
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
export function xlsxFixture(legacy = false, wide = false) {
  const workbook = XLSX.utils.book_new();
  const rows = Array.from({ length: 115 }, (_, index) => [index ? `病例 ${index}` : '病例编号', index ? index / 100 : '分数', index === 1 ? '<img src="https://office-private-preview.invalid/image" onerror="alert(1)">' : index ? '中文备注' : '备注']);
  if (wide) rows.forEach((row, index) => { for (let column = 3; column < 12; column++) row.push(index ? `数据 ${column + 1}` : `指标 ${column + 1}`); });
  const first = XLSX.utils.aoa_to_sheet(rows);
  first.D2 = { t: 'n', f: '1+1', v: 2 };
  if (!wide) first['!ref'] = 'A1:D115';
  XLSX.utils.book_append_sheet(workbook, first, '训练结果');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['第二个工作表'], ['备注内容']]), '数据备注');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: legacy ? 'biff8' : 'xlsx' }));
}
export async function pptxFixture() {
  const zip = new Zip();
  zip.file('[Content_Types].xml', declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.file('_rels/.rels', relationships('<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'));
  zip.file('ppt/presentation.xml', declaration + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', relationships([1, 2].map(i => `<Relationship Id="r${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`).join('')));
  for (const index of [1, 2]) zip.file(`ppt/slides/slide${index}.xml`, declaration + `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="标题">${index === 1 ? '<a:hlinkClick r:id="jump" action="ppaction://hlinksldjump"/>' : ''}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800">${index === 1 ? '<a:hlinkClick r:id="jump" action="ppaction://hlinksldjump"/>' : ''}</a:rPr><a:t>中文幻灯片 ${index}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', relationships('<Relationship Id="jump" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide2.xml"/>'));
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
