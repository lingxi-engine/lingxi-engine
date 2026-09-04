export interface VectorHit {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface IVectorStore {
  /**
   * Upsert a vector with associated metadata. Implementations should persist
   * and be durable across restarts (or document as ephemeral if not).
   */
  upsert(id: string, vector: number[], metadata?: Record<string, any>): Promise<void>;

  /** Search by vector similarity, returning top-k hits with scores and metadata. */
  searchVector(vector: number[], k: number): Promise<VectorHit[]>;

  /** Search by raw text (implementer may run embedding then search). */
  searchText(text: string, k: number): Promise<VectorHit[]>;

  /** Remove an item by id. */
  delete(id: string): Promise<void>;

  /** Optional lifecycle hook for initialization. */
  init?(): Promise<void>;
}

/**
 * Lightweight in-memory VectorStore useful for local dev and tests. Not for
 * production — stores raw arrays and performs cosine similarity on the fly.
 */
export class InMemoryVectorStore implements IVectorStore {
  private index = new Map<string, { vector: number[]; metadata?: Record<string, any> }>();

  async init(): Promise<void> {
    // no-op for memory store
  }

  async upsert(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    this.index.set(id, { vector, metadata });
  }

  private cosine(a: number[], b: number[]): number {
    const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    if (na === 0 || nb === 0) return 0;
    return dot / (na * nb);
  }

  async searchVector(vector: number[], k: number): Promise<VectorHit[]> {
    const out: VectorHit[] = [];
    for (const [id, rec] of this.index.entries()) {
      const score = this.cosine(vector, rec.vector);
      out.push({ id, score, metadata: rec.metadata });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  async searchText(_text: string, k: number): Promise<VectorHit[]> {
    // For convenience in tests: a naive fallback that returns top-k by insertion order.
    // Real adapters should embed text then call searchVector.
    const out: VectorHit[] = [];
    for (const [id, rec] of this.index.entries()) {
      out.push({ id, score: 0.0, metadata: rec.metadata });
    }
    return out.slice(0, k);
  }

  async delete(id: string): Promise<void> {
    this.index.delete(id);
  }
}
