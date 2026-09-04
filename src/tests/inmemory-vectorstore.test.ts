/**
 * inmemory-vectorstore.test.ts - InMemoryVectorStore 单元测试（vitest, P1/B2）
 *
 * 对齐 main 已合并的 src/memory/vector-store.ts 实现：
 *   - upsert(id, vector, metadata?)：Map 存储，同 id 覆盖
 *   - searchVector(vector, k)：余弦相似度，按分数降序，截断 top-k
 *   - searchText(text, k)：朴素回退（按插入序返回 top-k，score=0）
 *   - delete(id) / init()
 *
 * 断言核心契约：返回 VectorHit[] = { id, score, metadata }
 */
import { describe, it, expect } from "vitest";
import { InMemoryVectorStore, type VectorHit } from "../memory/vector-store.js";

// ═══════════════════════════════════════════════
// upsert
// ═══════════════════════════════════════════════

describe("InMemoryVectorStore.upsert", () => {
  it("stores items retrievable via searchVector", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("doc-1", [1, 0, 0], { source: "alpha" });
    await store.upsert("doc-2", [0, 1, 0], { source: "beta" });

    const hits = await store.searchVector([1, 0, 0], 10);
    expect(hits.map((h) => h.id).sort()).toEqual(["doc-1", "doc-2"]);
  });

  it("same id overwrites instead of duplicating", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("a", [1, 0, 0], { v: 1 });
    await store.upsert("a", [0, 0, 1], { v: 2 });

    const hits = await store.searchVector([0, 0, 1], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("a");
    expect(hits[0].metadata).toEqual({ v: 2 });
  });

  it("init() resolves (no-op lifecycle hook)", async () => {
    const store = new InMemoryVectorStore();
    await expect(store.init()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// searchVector：{ id, score, metadata } 契约
// ═══════════════════════════════════════════════

describe("InMemoryVectorStore.searchVector", () => {
  it("returns { id, score, metadata } hits sorted by score desc", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("doc-1", [1, 0, 0], { source: "alpha" });
    await store.upsert("doc-2", [0, 1, 0], { source: "beta" });
    await store.upsert("doc-3", [0.9, 0.1, 0], { source: "gamma" });

    const hits: VectorHit[] = await store.searchVector([1, 0, 0], 5);

    expect(hits.length).toBe(3);
    for (const h of hits) {
      expect(typeof h.id).toBe("string");
      expect(typeof h.score).toBe("number");
      expect(h.metadata).toEqual(expect.any(Object));
    }
    expect(hits[0].id).toBe("doc-1");
    expect(hits[0].score).toBeCloseTo(1, 6);
    expect(hits[0].metadata).toEqual({ source: "alpha" });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("respects k limit", async () => {
    const store = new InMemoryVectorStore();
    for (let i = 0; i < 5; i++) {
      await store.upsert(`v${i}`, [i, 1, 0]);
    }
    const hits = await store.searchVector([1, 1, 0], 2);
    expect(hits).toHaveLength(2);
  });

  it("returns empty array on empty store", async () => {
    const store = new InMemoryVectorStore();
    expect(await store.searchVector([1, 2, 3], 5)).toEqual([]);
  });

  it("zero vector yields score 0 (no NaN)", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("zero", [0, 0, 0]);
    const hits = await store.searchVector([1, 0, 0], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(0);
    expect(Number.isNaN(hits[0].score)).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// searchText：朴素回退契约（插入序 top-k，score=0）
// ═══════════════════════════════════════════════

describe("InMemoryVectorStore.searchText", () => {
  it("returns top-k in insertion order with score 0 and metadata", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("first", [1, 0, 0], { tag: "one" });
    await store.upsert("second", [0, 1, 0], { tag: "two" });
    await store.upsert("third", [0, 0, 1], { tag: "three" });

    const hits = await store.searchText("any query text", 2);

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.id)).toEqual(["first", "second"]);
    for (const h of hits) {
      expect(h.score).toBe(0);
      expect(h.metadata).toEqual(expect.any(Object));
    }
  });

  it("returns empty array on empty store", async () => {
    const store = new InMemoryVectorStore();
    expect(await store.searchText("anything", 5)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// delete
// ═══════════════════════════════════════════════

describe("InMemoryVectorStore.delete", () => {
  it("removes the item from subsequent searches", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("keep", [1, 0, 0], { v: 1 });
    await store.upsert("drop", [0, 1, 0], { v: 2 });

    await store.delete("drop");

    const hits = await store.searchVector([1, 0, 0], 10);
    expect(hits.map((h) => h.id)).toEqual(["keep"]);
  });
});