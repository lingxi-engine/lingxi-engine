/**
 * 语义去重模块：MinHash + LSH 近似去重
 * 依赖：无外部依赖，纯 TS 实现
 * 用法：import { SemanticDedup } from './semantic-dedup.js';
 *       const dedup = new SemanticDedup(0.85); // 相似度阈值，中文建议 0.8-0.85
 *       const isDup = await dedup.checkAndAdd('fact_key', 'fact_value');
 */

// 轻量级 MinHash 实现（无外部依赖）
export class MinHash {
  private permutations: number[][];
  private seed: number;

  constructor(
    public readonly numHashes: number = 128,
    seed: number = 0xdeadbeef
  ) {
    this.seed = seed;
    this.permutations = this.generatePermutations(numHashes);
  }

  private generatePermutations(n: number): number[][] {
    const perms: number[][] = [];
    for (let i = 0; i < n; i++) {
      const perm = Array.from({ length: 65536 }, (_, idx) => idx);
      // Fisher-Yates shuffle with deterministic seed per permutation
      let hash = this.seed + i * 0x9e3779b9;
      for (let j = perm.length - 1; j > 0; j--) {
        hash = (hash * 1664525 + 1013904223) >>> 0;
        const k = hash % (j + 1);
        [perm[j], perm[k]] = [perm[k], perm[j]];
      }
      perms.push(perm);
    }
    return perms;
  }

  // 将文本转为词级 shingle 集合（中文按字、英文按词）
  private getShingles(text: string): Set<number> {
    const shingles = new Set<number>();
    const normalized = text.toLowerCase().replace(/\s+/g, '');
    
    // 中文按单字，英文按词分割
    const tokens: string[] = [];
    let currentWord = '';
    for (const ch of normalized) {
      if (/[a-z0-9]/i.test(ch)) {
        currentWord += ch;
      } else {
        if (currentWord) { tokens.push(currentWord); currentWord = ''; }
        tokens.push(ch); // 中文字符单独成词
      }
    }
    if (currentWord) tokens.push(currentWord);

    // 生成 2-gram shingles
    for (let i = 0; i < tokens.length - 1; i++) {
      const gram = tokens[i] + tokens[i + 1];
      let h = 0;
      for (const ch of gram) {
        h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      }
      shingles.add(h);
    }
    // 单 token 也加入
    for (const token of tokens) {
      let h = 0;
      for (const ch of token) {
        h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
      }
      shingles.add(h);
    }
    return shingles;
  }

  // 计算 MinHash 签名
  signature(text: string): number[] {
    const shingles = this.getShingles(text);
    const sig = new Array(this.numHashes).fill(65535);
    for (const shingle of shingles) {
      for (let i = 0; i < this.numHashes; i++) {
        const permuted = this.permutations[i][shingle];
        if (permuted < sig[i]) sig[i] = permuted;
      }
    }
    return sig;
  }

  // 估算 Jaccard 相似度
  static jaccardSimilarity(sigA: number[], sigB: number[]): number {
    let matches = 0;
    for (let i = 0; i < sigA.length; i++) {
      if (sigA[i] === sigB[i]) matches++;
    }
    return matches / sigA.length;
  }
}

// LSH 索引：将签名分桶，快速候选检索
export class LSHIndex {
  private buckets: Map<string, Set<string>> = new Map();
  private signatures: Map<string, number[]> = new Map();
  private readonly bands: number;
  private readonly rowsPerBand: number;

  constructor(
    private readonly minHash: MinHash,
    bands: number = 16
  ) {
    this.bands = bands;
    this.rowsPerBand = minHash.numHashes / bands;
    if (!Number.isInteger(this.rowsPerBand)) {
      throw new Error('numHashes 必须能被 bands 整除');
    }
  }

  private getBandKey(sig: number[], bandIdx: number): string {
    const start = bandIdx * this.rowsPerBand;
    const end = start + this.rowsPerBand;
    return sig.slice(start, end).join(',');
  }

  add(key: string, text: string): void {
    const sig = this.minHash.signature(text);
    this.signatures.set(key, sig);
    for (let b = 0; b < this.bands; b++) {
      const bucketKey = `b${b}:${this.getBandKey(sig, b)}`;
      if (!this.buckets.has(bucketKey)) this.buckets.set(bucketKey, new Set());
      this.buckets.get(bucketKey)!.add(key);
    }
  }

  // 返回候选键集合
  query(text: string): Set<string> {
    const sig = this.minHash.signature(text);
    const candidates = new Set<string>();
    for (let b = 0; b < this.bands; b++) {
      const bucketKey = `b${b}:${this.getBandKey(sig, b)}`;
      const bucket = this.buckets.get(bucketKey);
      if (bucket) for (const k of bucket) candidates.add(k);
    }
    return candidates;
  }

  remove(key: string): void {
    const sig = this.signatures.get(key);
    if (!sig) return;
    for (let b = 0; b < this.bands; b++) {
      const bucketKey = `b${b}:${this.getBandKey(sig, b)}`;
      this.buckets.get(bucketKey)?.delete(key);
    }
    this.signatures.delete(key);
  }

  getSignature(key: string): number[] | undefined {
    return this.signatures.get(key);
  }
}

// 主去重类：对外暴露 checkAndAdd(key, value) -> boolean (true=重复)
export class SemanticDedup {
  private lsh: LSHIndex;
  private minHash: MinHash;
  private readonly threshold: number;

  constructor(threshold: number = 0.85, numHashes: number = 128, bands: number = 16) {
    this.threshold = threshold;
    this.minHash = new MinHash(numHashes);
    this.lsh = new LSHIndex(this.minHash, bands);
  }

  // 核心接口：检查是否重复，不重复则加入索引
  async checkAndAdd(key: string, value: string): Promise<boolean> {
    const candidates = this.lsh.query(value);
    for (const candKey of candidates) {
      const candSig = this.lsh.getSignature(candKey);
      if (!candSig) continue;
      const newSig = this.minHash.signature(value);
      const sim = MinHash.jaccardSimilarity(candSig, newSig);
      if (sim >= this.threshold) {
        return true; // 重复
      }
    }
    this.lsh.add(key, value);
    return false; // 不重复，已入库
  }

  // 批量重建索引（用于启动时从 DB 加载现有 facts）
  rebuild(entries: Array<{ key: string; value: string }>): void {
    this.lsh = new LSHIndex(this.minHash, this.lsh['bands']); // 重置
    for (const { key, value } of entries) {
      this.lsh.add(key, value);
    }
  }

  remove(key: string): void {
    this.lsh.remove(key);
  }
}

// 导出单例（进程内复用）——中文场景阈值调低到 0.85
export const globalDedup = new SemanticDedup(0.85);