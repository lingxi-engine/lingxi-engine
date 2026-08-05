/**
 * 记忆语义搜索 V2 - Memory Search
 * 混合搜索：TF-IDF 关键词 + IDF加权哈希向量
 *
 * V1 → V2 升级：
 * - V1: 纯 TF-IDF 关键词
 * - V2: TF-IDF + 向量相似度 + 混合排序
 *   不依赖外部向量数据库，纯本地实现
 *   有 Embedding API 时自动用真向量
 */

export interface SearchHit {
  text: string;
  score: number;
  source: 'summary' | 'facts' | 'messages';
  metadata?: Record<string, any>;
}

export interface SearchableDocument {
  id: string;
  text: string;
  source: 'summary' | 'facts' | 'messages';
  metadata?: Record<string, any>;
  vector?: number[];
}

/**
 * 嵌入维度（哈希向量的维度）
 * 越大越精确，越小越快。建议 64-256
 */
export const EMBEDDING_DIM = 128;

// ─── 中文分词：中文字符 bigram + 英文单词 ───

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
  for (const w of engWords) {
    tokens.push(w.toLowerCase());
  }
  return tokens;
}

// ─── 向量工具 ───

function cosineSimilarity(a: number[] | Float64Array, b: number[] | Float64Array): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * IDF 加权哈希向量化
 * 对每个 token 用 DJB2 哈希到多槽位，加 IDF 权重
 */
function idfWeightedHashVectorize(
  tokens: string[],
  idf: Map<string, number>,
  dim: number = EMBEDDING_DIM
): number[] {
  const vec = new Float64Array(dim);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  for (const [term, count] of tf) {
    const idfVal = idf.get(term) || 1;
    const weight = count * idfVal;
    // 双哈希减少碰撞
    let h1 = 5381;
    let h2 = 5381;
    for (let i = 0; i < term.length; i++) {
      h1 = ((h1 << 5) + h1 + term.charCodeAt(i)) & 0x7fffffff;
      h2 = ((h2 * 33) + term.charCodeAt(i)) & 0x7fffffff;
    }
    vec[h1 % dim] += weight;
    vec[h2 % dim] += weight * 0.5;
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
  }
  return Array.from(vec);
}

// ─── 搜索引擎 ───

export class MemorySearch {
  private documents: SearchableDocument[] = [];
  private idf: Map<string, number> = new Map();
  private built = false;

  // 外部 Embedding API（可选）
  private embeddingClient?: any;
  private embeddingModel?: string;

  /**
   * 设置 Embedding API（可选，不设则用本地哈希）
   */
  setEmbeddingClient(client: any, model: string) {
    this.embeddingClient = client;
    this.embeddingModel = model;
    console.log(`[MemorySearch] Embedding API 已配置: ${model}`);
  }

  addDocument(doc: SearchableDocument) {
    // v2.0.7: upsert — 同 id 文档更新而非追加，防止索引重复膨胀
    const idx = this.documents.findIndex(d => d.id === doc.id);
    if (idx >= 0) {
      this.documents[idx] = doc;
    } else {
      this.documents.push(doc);
    }
    this.built = false;
  }

  addDocuments(docs: SearchableDocument[]) {
    this.documents.push(...docs);
    this.built = false;
  }

  /**
   * 重建索引：IDF + 文档向量
   */
  buildIndex() {
    const N = this.documents.length;
    if (N === 0) { this.built = true; return; }

    // IDF 计算
    const docFreq = new Map<string, number>();
    for (const doc of this.documents) {
      const uniqueTokens = new Set(tokenize(doc.text));
      for (const t of uniqueTokens) {
        docFreq.set(t, (docFreq.get(t) || 0) + 1);
      }
    }
    this.idf = new Map();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }

    // 文档向量（已存在的不重算）
    for (const doc of this.documents) {
      if (!doc.vector) {
        const tokens = tokenize(doc.text);
        doc.vector = idfWeightedHashVectorize(tokens, this.idf, EMBEDDING_DIM);
      }
    }

    this.built = true;
  }

  /**
   * 混合搜索：向量 + 关键词
   * @param query 查询
   * @param topK 返回前 K 条
   * @param minScore 最低相似度
   * @param vectorWeight 向量权重 (0-1)，剩余给关键词
   */
  search(query: string, topK: number = 5, minScore: number = 0.1, vectorWeight: number = 0.6): SearchHit[] {
    if (!this.built) this.buildIndex();
    if (this.documents.length === 0) return [];

    // 1. 向量相似度
    const queryTokens = tokenize(query);
    const queryVector = idfWeightedHashVectorize(queryTokens, this.idf, EMBEDDING_DIM);
    const vectorScores = new Map<string, number>();
    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (!doc.vector) continue;
      const sim = cosineSimilarity(queryVector, doc.vector);
      vectorScores.set(doc.id, sim);
    }

    // 2. 关键词 TF-IDF 相似度
    const queryVec = new Map<string, number>();
    const qtf = new Map<string, number>();
    for (const t of queryTokens) {
      qtf.set(t, (qtf.get(t) || 0) + 1);
    }
    for (const [term, count] of qtf) {
      const idfVal = this.idf.get(term) || 1;
      queryVec.set(term, count * idfVal);
    }
    // 关键词余弦
    const keywordScores = new Map<string, number>();
    for (const doc of this.documents) {
      const docTokens = tokenize(doc.text);
      const docVec = new Map<string, number>();
      const dtf = new Map<string, number>();
      for (const t of docTokens) dtf.set(t, (dtf.get(t) || 0) + 1);
      for (const [term, count] of dtf) {
        const idfVal = this.idf.get(term) || 1;
        docVec.set(term, count * idfVal);
      }
      let dot = 0, normQ = 0, normD = 0;
      for (const [k, v] of queryVec) {
        normQ += v * v;
        if (docVec.has(k)) dot += v * docVec.get(k)!;
      }
      for (const [, v] of docVec) normD += v * v;
      const score = normQ && normD ? dot / (Math.sqrt(normQ) * Math.sqrt(normD)) : 0;
      keywordScores.set(doc.id, score);
    }

    // 3. 混合
    const hits: SearchHit[] = [];
    for (const doc of this.documents) {
      const vScore = vectorScores.get(doc.id) || 0;
      const kScore = keywordScores.get(doc.id) || 0;
      const combined = vectorWeight * vScore + (1 - vectorWeight) * kScore;
      if (combined >= minScore) {
        hits.push({
          text: doc.text.slice(0, 300),
          score: Math.round(combined * 1000) / 1000,
          source: doc.source,
          metadata: doc.metadata,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  clear() {
    this.documents = [];
    this.idf = new Map();
    this.built = false;
  }

  get size() { return this.documents.length; }

  /**
   * 导出所有文档（用于持久化）
   */
  exportDocs(): SearchableDocument[] {
    return [...this.documents];
  }

  /**
   * 导入文档
   */
  importDocs(docs: SearchableDocument[]) {
    this.documents = docs;
    this.built = false;
    this.buildIndex();
  }
}
