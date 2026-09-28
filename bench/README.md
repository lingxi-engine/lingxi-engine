/**
 * bench/README.md — LingXi benchmark suite
 *
 * Two tiers:
 *   Tier 1  deterministic, free, no LLM. CI-gate. Proves the engineering floor.
 *   Tier 2  live LLM, costs tokens. Proves agentic capability, machine-scored.
 *
 * Quick start
 * -----------
 *   npm run bench            # tier1 + tier2 (deepseek by default)
 *   npm run bench:fast       # tier1 only, free, no tokens
 *   npm run bench:agentic    # tier2 only
 *
 * Files
 * -----
 *   harness.mts           shared Suite/Report/manifest primitives
 *   tier1-contract.mts    tool contracts, long-task budgets, subsystem presence
 *   tier1-safety.mts      SSRF policy, path safety
 *   tier2-agentic.mts     12 agentic cases against a live LLM
 *   run-all.mts           runs everything, writes summary.json + REPORT.md
 *
 * Why there is no LLM judge
 * -------------------------
 * A model grading another model produces numbers that drift with prompt wording and
 * are impossible to reproduce. Every tier-2 assertion here is machine-verifiable:
 * exact file bytes, a regex over the reply, numeric equality, or the recorded tool-call
 * trace. That means the score means the same thing on every run and across model swaps.
 *
 * Scoring
 * -------
 *   score = passed assertions / total assertions, per suite, 0-100.
 *   Exit code 0 requires tier-1 = 100% and tier-2 >= 70%.
 *
 * Adding a case
 * -------------
 * Append to CASES in tier2-agentic.mts. Each case is:
 *   { id, category, difficulty, task, verify(result) => Assertion[] }
 * `verify` receives { steps, sawToolCall, text, trace } and returns named
 * pass/fail assertions. Use `read(fileName)` to assert on workspace side effects.
 *
 * The workspace (bench/_agentic_ws) is wiped before every case, so cases are
 * independent and order does not matter.
 *
 * SSRF policy note
 * ----------------
 * tier1-safety.mts asserts the REAL v1.9.2 policy: block cloud metadata endpoints
 * (169.254.169.254, metadata.google.internal, 100.100.100.200) and non-http schemes,
 * but ALLOW localhost/RFC1918. That is deliberate — the agent runs on the user's own
 * machine and must be able to reach a local Ollama. If someone hardens the policy,
 * these tests fail by design; update the allow-list in that file at the same time.
