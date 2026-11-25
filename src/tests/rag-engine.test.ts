import { describe, it, expect } from 'vitest';
import { RAGEngine, semanticChunk, chunkDocument, type RAGDocument } from '../core/rag-engine.js';

function doc(id: string, title: string, content: string): RAGDocument {
  return { id, title, source: title, mimeType: 'text/plain', content, createdAt: Date.now(), metadata: {} };
}

describe('rag-engine: chunking', () => {
  it('semanticChunk splits long content into bounded pieces', () => {
    const para = '灵犀引擎是一个本地优先的 AI 引擎。'.repeat(40);
    const content = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n${para}`).join('\n\n');
    const chunks = semanticChunk(content, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeGreaterThanOrEqual(10);
  });

  it('semanticChunk returns empty for trivial input', () => {
    expect(semanticChunk('short')).toEqual([]);
  });

  it('chunkDocument respects chunkSize and keeps overlap', () => {
    const text = '这是一个句子。'.repeat(200);
    const chunks = chunkDocument(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 + 40);
  });

  it('chunkDocument handles non-string input defensively', () => {
    expect(chunkDocument(null as any)).toEqual([]);
    expect(chunkDocument(undefined as any)).toEqual([]);
  });
});

describe('rag-engine: document lifecycle', () => {
  it('addDocument returns chunk count and lists the document', async () => {
    const eng = new RAGEngine();
    const n = await eng.addDocument(doc('d1', 'Guide', '灵犀引擎支持好友聊天与多AI协作。'.repeat(30)));
    expect(n).toBeGreaterThan(0);
    const list = eng.listDocuments();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('d1');
    expect(list[0].chunkCount).toBe(n);
  });

  it('removeDocument deletes the doc and its chunks', async () => {
    const eng = new RAGEngine();
    await eng.addDocument(doc('d1', 'A', '内容甲。'.repeat(40)));
    await eng.addDocument(doc('d2', 'B', '内容乙。'.repeat(40)));
    expect(eng.removeDocument('d1')).toBe(true);
    expect(eng.removeDocument('missing')).toBe(false);
    expect(eng.listDocuments().map(d => d.id)).toEqual(['d2']);
    expect(eng.exportData().chunks.every(c => c.docId !== 'd1')).toBe(true);
  });

  it('exportData / importData round-trips the knowledge base', async () => {
    const a = new RAGEngine();
    await a.addDocument(doc('d1', 'Round', '往返测试内容。'.repeat(40)));
    const snapshot = a.exportData();
    const b = new RAGEngine();
    b.importData(snapshot);
    expect(b.listDocuments()).toHaveLength(1);
    expect(b.exportData().chunks.length).toBe(snapshot.chunks.length);
  });
});

describe('rag-engine: search (hash vector path, no network)', () => {
  it('returns relevant hits for a matching query', async () => {
    const eng = new RAGEngine();
    await eng.addDocument(doc('cats', 'Cats', '猫是一种可爱的宠物，喜欢睡觉和抓老鼠。'.repeat(20)));
    await eng.addDocument(doc('cars', 'Cars', '汽车是一种交通工具，需要加油和保养。'.repeat(20)));
    const hits = await eng.search('猫 宠物', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBeTruthy();
    expect(typeof hits[0].score).toBe('number');
  });

  it('returns empty array when the knowledge base is empty', async () => {
    const eng = new RAGEngine();
    expect(await eng.search('anything')).toEqual([]);
  });

  it('honors topK limit', async () => {
    const eng = new RAGEngine();
    for (let i = 0; i < 5; i++) await eng.addDocument(doc('d' + i, 'T' + i, '共同关键词内容。'.repeat(30)));
    const hits = await eng.search('共同关键词', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
