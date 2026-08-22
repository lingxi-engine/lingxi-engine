/**
 * Office 文档读取器 — 零依赖，解析 docx/xlsx/pptx（ZIP+XML 格式）
 */
import { readFileSync } from 'fs';
import { inflateRawSync, inflateSync } from 'zlib';

// ═══════════════════════════════════════════════
// PDF 文本提取（零依赖，支持 FlateDecode 流）
// ═══════════════════════════════════════════════

function decompressPdfStream(buf: Buffer, filter: string): Buffer {
  try {
    if (filter === 'FlateDecode') return inflateSync(buf);
    if (!filter || filter === 'ASCIIHexDecode' || filter === 'ASCII85Decode') return buf; // 简化处理
    return buf; // 未知 filter，返回原数据
  } catch { return buf; }
}

function pdfFindObjects(buffer: Buffer): Map<number, { offset: number }> {
  const objs = new Map<number, { offset: number }>();
  // 简单 xref 表解析
  const text = buffer.toString('latin1');
  const xrefMatch = text.match(/startxref\s*(\d+)/);
  if (!xrefMatch) return objs;
  const xrefOffset = parseInt(xrefMatch[1]);
  const xrefSection = text.substring(xrefOffset);
  // 解析 xref table: "0000000001 00000 n" 格式
  const xrefLines = xrefSection.match(/xref[\s\S]*?trailer/i) || [];
  const entryRegex = /(\d{10}) (\d{5}) ([nf])/g;
  let m;
  while ((m = entryRegex.exec(xrefLines[0] || '')) !== null) {
    const offset = parseInt(m[1]);
    if (offset > 0 && offset < buffer.length) objs.set(offset, { offset });
  }
  return objs;
}

function pdfExtractTextFromStream(streamData: Buffer): string {
  const text = streamData.toString('latin1');
  const parts: string[] = [];

  // Tj: (text) Tj — 显示文字
  const tjRegex = /\(([^)]*(?:\\.[^)]*)*)\)\s*Tj/g;
  let m;
  while ((m = tjRegex.exec(text)) !== null) {
    let t = m[1].replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    if (t.trim()) parts.push(t);
  }

  // TJ: [(text) num (text)] TJ — 带字间距的文字数组
  const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
  while ((m = tjArrayRegex.exec(text)) !== null) {
    const inner = m[1];
    const strRegex = /\(([^)]*(?:\\.[^)]*)*)\)/g;
    let s;
    while ((s = strRegex.exec(inner)) !== null) {
      let t2 = s[1].replace(/\\([()\\])/g, '$1');
      if (t2.trim()) parts.push(t2);
    }
  }

  // ': (text) ' — 简写
  const quoteRegex = /'([^']*(?:\\.[^']*)*)'/g;
  while ((m = quoteRegex.exec(text)) !== null) {
    let t3 = m[1].replace(/\\/g, '');
    if (t3.trim() && t3.length < 500) parts.push(t3);
  }

  // 如果什么都没提取到，返回原始文本的前1000字符
  return parts.length > 0 ? parts.join(' ') : text.substring(0, 1000).replace(/[^\x20-\x7E\u4e00-\u9fff\n]/g, '');
}

function pdfFindPagesContent(buffer: Buffer): Buffer[] {
  const results: Buffer[] = [];
  const text = buffer.toString('latin1');

  // 找所有 stream 对象的位置
  // obj << ... >> stream ... endstream
  const objRegex = /(\d+)\s+\d+\s+obj[\s\S]*?<<([\s\S]*?)>>/g;
  let mobj;
  while ((mobj = objRegex.exec(text)) !== null) {
    const dict = mobj[2];
    // 检查是否是页面内容流
    if (!dict.includes('/Type') && !dict.includes('/Page') && !dict.includes('/Font') && !dict.includes('/Contents')) continue;

    const streamStart = text.indexOf('stream', mobj.index + mobj[0].length);
    if (streamStart < 0) continue;
    const streamDataStart = streamStart + 6; // skip "stream"
    if (text[streamDataStart] === '\r') continue; // skip \r
    const streamDataIdx = text[streamDataStart] === '\n' ? streamDataStart + 1 : streamDataStart;

    const endstreamIdx = text.indexOf('endstream', streamDataIdx);
    if (endstreamIdx < 0) continue;

    const streamData = buffer.subarray(streamDataIdx, endstreamIdx);
    const filter = dict.includes('/FlateDecode') ? 'FlateDecode' : '';

    try {
      const decompressed = decompressPdfStream(streamData, filter);
      results.push(decompressed);
    } catch { results.push(streamData); }
  }
  return results;
}

export function readPdfDocument(filePath: string): OfficeReadResult {
  try {
    const buffer = readFileSync(filePath);
    const streams = pdfFindPagesContent(buffer);
    if (streams.length === 0) return { ok: false, content: '', type: 'pdf', error: 'PDF 无文本内容或加密' };
    const texts: string[] = [];
    for (const stream of streams) {
      const t = pdfExtractTextFromStream(stream);
      if (t.trim()) texts.push(t);
    }
    const content = texts.join('\n\n');
    return { ok: true, content: content || '(无法提取文本的 PDF)', type: 'pdf' };
  } catch (e: any) {
    return { ok: false, content: '', type: 'pdf', error: e.message };
  }
}

// ═══════════════════════════════════════════════
// ZIP 解析（用于 docx/xlsx/pptx）
// ═══════════════════════════════════════════════

interface ZipEntry {
  name: string;
  offset: number;
  size: number;
  compressedSize: number;
  method: number;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  // 找 central directory 起始位置（末尾 ~22 字节处有 end-of-central-directory 签名）
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer[i] === 0x50 && buffer[i+1] === 0x4b && buffer[i+2] === 0x05 && buffer[i+3] === 0x06) {
      const cdOffset = buffer.readUInt32LE(i + 16);
      const cdSize = buffer.readUInt32LE(i + 12);
      // 遍历 central directory entries
      let pos = cdOffset;
      const end = cdOffset + cdSize;
      while (pos < end - 46) {
        if (buffer[pos] !== 0x50 || buffer[pos+1] !== 0x4b) break;
        const method = buffer.readUInt16LE(pos + 10);
        const compSize = buffer.readUInt32LE(pos + 20);
        const uncompSize = buffer.readUInt32LE(pos + 24);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
        entries.push({
          name,
          offset: localOffset,
          size: uncompSize,
          compressedSize: compSize,
          method,
        });
        pos += 46 + nameLen + extraLen + commentLen;
      }
      break;
    }
  }
  return entries;
}

function extractEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  // Local file header: 30 bytes + filename
  let pos = entry.offset + 30;
  const localNameLen = buffer.readUInt16LE(entry.offset + 26);
  const localExtraLen = buffer.readUInt16LE(entry.offset + 28);
  pos += localNameLen + localExtraLen;
  
  const data = buffer.subarray(pos, pos + entry.compressedSize);
  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return inflateRawSync(data); // deflated
  return data; // unknown, return raw
}

function extractTextFromDocxXml(xml: string): string {
  // 提取 <w:t> 文本节点
  const parts: string[] = [];
  const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    if (m[1]) parts.push(m[1]);
  }
  // 在段落末尾加换行
  const withBreaks = xml.replace(/<w:p[ >]/g, '\n<w:p ').replace(/<w:br[^>]*\/>/g, '\n');
  if (parts.length === 0) {
    // fallback: strip all tags
    return withBreaks.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return parts.join('');
}

function extractTextFromXlsxXml(sharedStrings: string, sheetXml: string): string {
  // 解析 shared strings
  const strings: string[] = [];
  const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(sharedStrings)) !== null) {
    const tMatch = m[1].match(/<t[^>]*>([^<]*)<\/t>/);
    strings.push(tMatch ? tMatch[1] : '');
  }
  // 解析 sheet data，替换 shared string 引用
  const rows: string[] = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  while ((m = rowRegex.exec(sheetXml)) !== null) {
    const cells: string[] = [];
    const cRegex = /<c[^>]*t="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g;
    let c;
    while ((c = cRegex.exec(m[1])) !== null) {
      const idx = parseInt(c[1]);
      if (idx >= 0 && idx < strings.length) cells.push(strings[idx]);
    }
    // also inline strings
    const inRegex = /<c[^>]*t="inlineStr"[^>]*>[\s\S]*?<t[^>]*>([^<]*)<\/t>[\s\S]*?<\/c>/g;
    while ((c = inRegex.exec(m[1])) !== null) {
      cells.push(c[1]);
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

function extractTextFromPptxXml(slideXml: string): string {
  // 提取 <a:t> 文本
  const parts: string[] = [];
  const regex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
  let m;
  while ((m = regex.exec(slideXml)) !== null) {
    if (m[1]) parts.push(m[1]);
  }
  return parts.join('\n');
}

export interface OfficeReadResult {
  ok: boolean;
  content: string;
  type: string;
  error?: string;
}

export function readOfficeDocument(filePath: string): OfficeReadResult {
  try {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (ext === 'pdf') return readPdfDocument(filePath);
    if (!['docx', 'xlsx', 'pptx'].includes(ext)) {
      return { ok: false, content: '', type: ext, error: `不支持的格式: .${ext}` };
    }

    const buffer = readFileSync(filePath);
    const entries = readZipEntries(buffer);

    if (ext === 'docx') {
      const docEntry = entries.find(e => e.name === 'word/document.xml');
      if (!docEntry) return { ok: false, content: '', type: 'docx', error: '无效的 docx 文件: 找不到 document.xml' };
      const xml = extractEntryData(buffer, docEntry).toString('utf8');
      return { ok: true, content: extractTextFromDocxXml(xml), type: 'docx' };
    }

    if (ext === 'xlsx') {
      const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
      const sheetEntry = entries.find(e => e.name === 'xl/worksheets/sheet1.xml');
      if (!sheetEntry) return { ok: false, content: '', type: 'xlsx', error: '无效的 xlsx 文件' };
      const ssXml = ssEntry ? extractEntryData(buffer, ssEntry).toString('utf8') : '';
      const sheetXml = extractEntryData(buffer, sheetEntry).toString('utf8');
      return { ok: true, content: extractTextFromXlsxXml(ssXml, sheetXml), type: 'xlsx' };
    }

    if (ext === 'pptx') {
      // pptx: 收集所有 slide XML
      const slideEntries = entries.filter(e => e.name.startsWith('ppt/slides/slide') && e.name.endsWith('.xml'));
      const texts: string[] = [];
      for (const se of slideEntries) {
        const xml = extractEntryData(buffer, se).toString('utf8');
        texts.push(extractTextFromPptxXml(xml));
      }
      return { ok: true, content: texts.join('\n---\n'), type: 'pptx' };
    }

    return { ok: false, content: '', type: ext, error: '未知格式' };
  } catch (e: any) {
    return { ok: false, content: '', type: '', error: e.message };
  }
}