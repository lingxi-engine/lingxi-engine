# Tool & VectorStore adoption guide

This short guide explains the new interfaces added to the codebase and suggests
how to progressively refactor existing tools and retrieval calls to use them.

Files added:
- src/tools/tool-base.ts — ITool interface and ToolBase abstract class
- src/memory/vector-store.ts — IVectorStore interface and InMemoryVectorStore reference implementation

Why this change?
- Unifies how "tools" (external side-effects) are represented so we can centrally
  enforce permissions, dry-run behavior and timeouts.
- Abstracts vector/semantic memory behind a simple interface so the project can
  switch between in-memory, FAISS, Milvus, pgvector or cloud vector DBs without
  scattering implementation details across code.

Quick migration recipe (do incrementally):
1. Pick one tool (e.g. src/tools/browser.ts) and add `implements ITool` to its
   exported class/function. Implement dryRun that returns a safe preview (no side-effects).
2. Update the ToolRegistry (src/tools/registry.ts) to accept ITool instances and
   call `tool.execute()` instead of invoking internal functions directly.
3. Replace any ad-hoc vector search calls with the VectorStore interface. Add
   a concrete adapter (e.g. `src/memory/adapter-fake.ts`) that wraps your
   existing search provider and implements `searchText` and `searchVector`.
4. Add unit tests for one tool and for the in-memory vector store.

Next steps I can take for you (pick one):
- Refactor a single tool (browser or executor) to implement ITool and update registry.
- Add an adapter that wraps the existing search/providers and implements IVectorStore.
- Add a lightweight unit test for InMemoryVectorStore and wire a test runner (vitest).

Tell me which of the above you want me to implement next and I will create a PR.
