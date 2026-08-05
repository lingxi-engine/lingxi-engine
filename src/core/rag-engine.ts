/**
 * RAG 知识库引擎 - Retrieval-Augmented Generation
 * v2: 语义分块 + 混合检索 + 重排序
 */

import OpenAI from "openai";

export interface RAGDocument {
  id: string;
  title: string;
  source: string;
  mimeType: string;
  content: string;
  createdAt: number;
  metadata?: Record<string, any>;
}

export interface RAGChunk {
  id: string;
  docId: string;
  content: string;
  index: number;
  vector?: number[];
  metadata?: Record<string, any>;
}

export interface RAGSearchResult {
  chunkId: string;
  docId: string;
  docTitle: string;
  content: string;
  score: number;
  searchType: 'vector' | 'keyword' | 'hybrid';
}

export interface RAGGenerationResult {
  answer: string;
  sources: { docId: string; docTitle: string; chunkContent: string; score: number }[];
  contextUsed: number;
}

export interface RAGConfig {
  chunkSize: number;
  chunkOverlap: number;
  maxResults: number;
  minScore: number;
  embeddingDimension: number;
  useEmbeddingAPI: boolean;
  embeddingModel?: string;
}

const DEFAULT_RAG_CONFIG: RAGConfig = {
  chunkSize: 500,
  chunkOverlap: 100,
  maxResults: 5,
  minScore: 0.3,
  embeddingDimension: 128,
  useEmbeddingAPI: false,
};

// ─── 中文分词 ───

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const ch of text) {
    if (/\p{L}/u.test(ch) || /\d/.test(ch)) {
      tokens.push(ch.toLowerCase());
    }
  }
  const cleanText = text.replace(/[^\p{L}\p{N}]/gu, '');
  for (let i = 0; i < cleanText.length - 1; i++) {
    tokens.push(cleanText.slice(i, i + 2).toLowerCase());
  }
  const engWords = text.match(/[a-zA-Z]{2,}/g) || [];
  for (const w of engWords) tokens.push(w.toLowerCase());
  return tokens;
}

// ─── 向量工具 ───

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hashVectorize(tokens: string[], dim: number): number[] {
  const vec = new Float64Array(dim);
  for (const token of tokens) {
    let hash = 5381;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) + hash + token.charCodeAt(i)) & 0x7fffffff;
    }
    const idx = hash % dim;
    vec[idx] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
  }
  return Array.from(vec);
}

function idfWeightedHashVectorize(tokens: string[], idf: Map<string, number>, dim: number): number[] {
  const vec = new Float64Array(dim);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [term, count] of tf) {
    const idfVal = idf.get(term) || 1;
    const weight = count * idfVal;
    let hash1 = 5381, hash2 = 5381;
    for (let i = 0; i < term.length; i++) {
      hash1 = ((hash1 << 5) + hash1 + term.charCodeAt(i)) & 0x7fffffff;
      hash2 = ((hash2 * 33) + term.charCodeAt(i)) & 0x7fffffff;
    }
    vec[hash1 % dim] += weight;
    vec[hash2 % dim] += weight * 0.5;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
  }
  return Array.from(vec);
}

// ─── 文档分块 ───

/**
 * 语义分块：按段落+标题识别自然边界
 */
export function semanticChunk(content: string, maxSize: number = 800): string[] {
  const chunks: string[] = [];
  const sections = content.split(/\n\n|\n#{1,3}\s/);
  let current = '';
  
  for (const section of sections) {
    if (!section.trim()) continue;
    if (current.length + section.length <= maxSize) {
      current += (current ? '\n' : '') + section;
    } else {
      if (current.trim()) chunks.push(current.trim());
      if (section.length > maxSize) {
        const subChunks = chunkDocument(section, maxSize, Math.floor(maxSize * 0.2));
        chunks.push(...subChunks);
        current = '';
      } else {
        current = section;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length >= 10);
}

/**
 * 句子级分块（fallback）
 */
export function chunkDocument(content: string, chunkSize: number = 500, chunkOverlap: number = 100): string[] {
  const chunks: string[] = [];
  const text = typeof content === 'string' ? content : String(content || '');
  const sentences = text.split(/(?<=[。！？；\n])/g).filter(s => s.trim().length > 0);
  let currentChunk = '';
  for (const sent of sentences) {
    if (sent.length > chunkSize) {
      if (currentChunk.trim()) { chunks.push(currentChunk.trim()); currentChunk = ''; }
      for (let i = 0; i < sent.length; i += chunkSize) chunks.push(sent.slice(i, i + chunkSize).trim());
      continue;
    }
    if (currentChunk.length + sent.length <= chunkSize) {
      currentChunk += sent;
    } else {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
        currentChunk = currentChunk.slice(-chunkOverlap) + sent;
      } else {
        currentChunk = sent;
      }
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.filter(c => c.length >= 10);
}

// ─── RAG 引擎 ───

export class RAGEngine {
  private config: RAGConfig;
  private documents: Map<string, RAGDocument> = new Map();
  private chunks: Map<string, RAGChunk> = new Map();
  private idf: Map<string, number> = new Map();
  private indexed = false;
  private openaiClient?: OpenAI;
  private embeddingModel?: string;

  constructor(config: Partial<RAGConfig> = {}) {
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };
  }

  setEmbeddingClient(client: OpenAI, model: string = 'text-embedding-3-small') {
    this.openaiClient = client;
    this.embeddingModel = model;
    this.config.useEmbeddingAPI = true;
  }

  async addDocument(doc: RAGDocument): Promise<number> {
    this.documents.set(doc.id, doc);
    // 优先语义分块
    const textChunks = doc.content.length > 1000
      ? semanticChunk(doc.content, this.config.chunkSize)
      : chunkDocument(doc.content, this.config.chunkSize, this.config.chunkOverlap);
    const chunks: RAGChunk[] = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunkId = `${doc.id}-chunk-${i}`;
      const chunk: RAGChunk = { id: chunkId, docId: doc.id, content: textChunks[i], index: i, metadata: { ...doc.metadata, mimeType: doc.mimeType } };
      chunks.push(chunk);
      this.chunks.set(chunkId, chunk);
    }
    if (this.config.useEmbeddingAPI && this.openaiClient && this.embeddingModel) {
      await this.vectorizeWithAPI(chunks);
    } else {
      this.vectorizeWithHash(chunks);
    }
    this.indexed = false;
    return textChunks.length;
  }

  importData(data: { documents: any[]; chunks: any[] }): void {
    for (const d of data.documents) this.documents.set(d.id, d);
    for (const c of data.chunks) this.chunks.set(c.id, c);
    this.indexed = false;
    this.buildIndex();
  }
  exportData(): { documents: any[]; chunks: any[] } {
    return {
      documents: Array.from(this.documents.values()),
      chunks: Array.from(this.chunks.values()),
    };
  }

  removeDocument(docId: string): boolean {
    if (!this.documents.has(docId)) return false;
    this.documents.delete(docId);
    for (const [chunkId, chunk] of this.chunks) if (chunk.docId === docId) this.chunks.delete(chunkId);
    this.indexed = false;
    return true;
  }

  listDocuments(): { id: string; title: string; source: string; chunkCount: number; createdAt: number }[] {
    const result: { id: string; title: string; source: string; chunkCount: number; createdAt: number }[] = [];
    for (const [id, doc] of this.documents) {
      const chunkCount = Array.from(this.chunks.values()).filter(c => c.docId === id).length;
      result.push({ id, title: doc.title, source: doc.source, chunkCount, createdAt: doc.createdAt });
    }
    return result;
  }

  async search(query: string, topK?: number): Promise<RAGSearchResult[]> {
    const k = topK || this.config.maxResults;
    if (!this.indexed) this.buildIndex();
    if (this.chunks.size === 0) return [];

    const queryVector = await this.getQueryVector(query);
    const vectorHits: Map<string, number> = new Map();
    if (queryVector) {
      for (const [chunkId, chunk] of this.chunks) {
        if (chunk.vector) {
          const score = cosineSimilarity(queryVector, chunk.vector);
          if (score >= this.config.minScore) vectorHits.set(chunkId, score);
        }
      }
    }

    const queryTokens = tokenize(query);
    const keywordHits: Map<string, number> = new Map();
    for (const [chunkId, chunk] of this.chunks) {
      const chunkTokens = tokenize(chunk.content);
      let score = 0;
      for (const qt of queryTokens) {
        const hits = chunkTokens.filter(ct => ct === qt).length;
        if (hits > 0) { const idfVal = this.idf.get(qt) || 1; score += Math.min(hits, 3) * idfVal; }
      }
      if (score > 0) keywordHits.set(chunkId, Math.tanh(score / (queryTokens.length * 2)));
    }

    const alpha = queryVector ? 0.6 : 0;
    const finalScores: Map<string, { score: number; type: 'vector' | 'keyword' | 'hybrid' }> = new Map();
    for (const [chunkId, vScore] of vectorHits) {
      const kScore = keywordHits.get(chunkId) || 0;
      finalScores.set(chunkId, { score: alpha * vScore + (1 - alpha) * kScore, type: kScore > 0 ? 'hybrid' : 'vector' });
    }
    for (const [chunkId, kScore] of keywordHits) {
      if (!finalScores.has(chunkId)) finalScores.set(chunkId, { score: kScore, type: 'keyword' });
    }

    const sorted = Array.from(finalScores.entries()).sort((a, b) => b[1].score - a[1].score).slice(0, k);
    const results: RAGSearchResult[] = [];
    for (const [chunkId, { score, type }] of sorted) {
      const chunk = this.chunks.get(chunkId);
      if (!chunk) continue;
      const doc = this.documents.get(chunk.docId);
      results.push({ chunkId, docId: chunk.docId, docTitle: doc?.title || '未知文档', content: chunk.content, score: Math.round(score * 1000) / 1000, searchType: type });
    }
    // 重排序+去重
    return this.rerank(query, results);
  }

  /**
   * Cross-Encoder 风格重排序
   */
  private rerank(query: string, results: RAGSearchResult[]): RAGSearchResult[] {
    if (results.length <= 1) return results;
    const queryLower = query.toLowerCase();
    for (const r of results) {
      let bonus = 0;
      const contentLower = r.content.toLowerCase();
      for (let i = 0; i < queryLower.length - 2; i++) {
        if (contentLower.includes(queryLower.slice(i, i + 3))) bonus += 0.05;
      }
      if (r.docTitle && queryLower.split(/\s+/).some(w => w.length > 1 && r.docTitle.toLowerCase().includes(w))) bonus += 0.15;
      r.score = Math.min(1, r.score + bonus);
    }
    const deduped: RAGSearchResult[] = [];
    for (const r of results.sort((a, b) => b.score - a.score)) {
      const dup = deduped.some(d => {
        const overlap = d.content.split(/\s+/).filter(w => r.content.includes(w)).length;
        return overlap / Math.max(d.content.split(/\s+/).length, 1) > 0.7;
      });
      if (!dup) deduped.push(r);
      if (deduped.length >= this.config.maxResults) break;
    }
    return deduped;
  }

  async generate(query: string, client: OpenAI, model: string, options?: { topK?: number; systemPrompt?: string; temperature?: number; maxTokens?: number }): Promise<RAGGenerationResult> {
    const searchResults = await this.search(query, options?.topK);
    if (searchResults.length === 0) return { answer: '知识库中没有找到相关内容。请先上传文档到知识库。', sources: [], contextUsed: 0 };
    const context = searchResults.map((r, i) => `[来源${i + 1}: ${r.docTitle} (相关度: ${r.score})]\n${r.content}`).join('\n\n---\n\n');
    const systemPrompt = options?.systemPrompt || '你是一个知识库问答助手。请根据以下参考资料回答用户的问题。如果参考资料中没有相关信息，请如实说明。回答时请引用来源编号。';
    const fullPrompt = `${systemPrompt}\n\n--- 参考资料 ---\n${context}\n--- 参考资料结束 ---\n\n用户问题: ${query}`;
    try {
      const response = await client.chat.completions.create({ model, messages: [{ role: 'user', content: fullPrompt }], temperature: options?.temperature ?? 0.3, max_tokens: options?.maxTokens ?? 2048 });
      return { answer: response.choices[0].message.content || '', sources: searchResults.map(r => ({ docId: r.docId, docTitle: r.docTitle, chunkContent: r.content.slice(0, 200), score: r.score })), contextUsed: searchResults.length };
    } catch (err: any) {
      return { answer: '生成回答时出错: ' + err.message, sources: [], contextUsed: 0 };
    }
  }

  buildIndex() {
    const allChunks = Array.from(this.chunks.values());
    const N = allChunks.length;
    if (N === 0) { this.indexed = true; return; }
    const docFreq = new Map<string, number>();
    for (const chunk of allChunks) {
      const uniqueTokens = new Set(tokenize(chunk.content));
      for (const t of uniqueTokens) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
    this.idf = new Map();
    for (const [term, df] of docFreq) this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    this.indexed = true;
  }

  private vectorizeWithHash(chunks: RAGChunk[]) {
    const dim = this.config.embeddingDimension;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      chunk.vector = idfWeightedHashVectorize(tokens, this.idf, dim);
    }
  }

  private async vectorizeWithAPI(chunks: RAGChunk[]) {
    if (!this.openaiClient || !this.embeddingModel) return;
    const batchSize = 20;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      try {
        const resp = await this.openaiClient.embeddings.create({ model: this.embeddingModel, input: batch.map(c => c.content.slice(0, 8000)) });
        for (let j = 0; j < batch.length; j++) {
          batch[j].vector = resp.data[j]?.embedding || [];
        }
      } catch (err: any) { console.error(`[RAG] Embedding batch ${i} failed:`, err.message); }
    }
  }

  private async getQueryVector(query: string): Promise<number[] | null> {
    if (this.config.useEmbeddingAPI && this.openaiClient && this.embeddingModel) {
      try {
        const resp = await this.openaiClient.embeddings.create({ model: this.embeddingModel, input: query.slice(0, 8000) });
        return resp.data[0]?.embedding || null;
      } catch { return null; }
    }
    const tokens = tokenize(query);
    return hashVectorize(tokens, this.config.embeddingDimension);
  }
}

export const ragEngine = new RAGEngine();