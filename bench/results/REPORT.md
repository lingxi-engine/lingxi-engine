# LingXi Engine — Benchmark Report

- engine: `2.0.28` (commit `b0c4117`)
- generated: 2026-09-28T14:02:00.976Z
- built-in tools: **56**

## Headline

| Tier | What it measures | Result | Cost |
|---|---|---|---|
| Tier 1 | tool contracts, SSRF policy, long-task budgets, subsystem presence | **100%** (150/150) | free |
| Tier 2 | agentic execution with a live LLM (`deepseek-chat`) | **100%** (65/65) | 28067 in / 1438 out |

> Tier 1 is deterministic and free, so it can gate every commit.
> Tier 2 spends tokens; the numbers below come from a real run against a live API.

## Tier 2 — agentic cases

| Case | Category | Score |
|---|---|---|
| `agent.write-basic` | tool-selection / easy | 100% (5/5) |
| `agent.calc-then-write` | multi-step / medium | 100% (5/5) |
| `agent.list-then-count` | multi-step / medium | 100% (6/6) |
| `agent.read-back-verify` | verification / hard | 100% (6/6) |
| `agent.constraint-respect` | instruction-following / hard | 100% (6/6) |
| `agent.recover-from-error` | recovery / hard | 100% (5/5) |
| `agent.calibrated-no-tool` | integrity / medium | 100% (5/5) |
| `agent.calibrated-honest-refusal` | integrity / medium | 100% (5/5) |
| `agent.serial-multi-step` | multi-step / hard | 100% (7/7) |
| `agent.sequential-state` | multi-step / hard | 100% (5/5) |
| `agent.negative-constraint` | instruction-following / medium | 100% (5/5) |
| `agent.tool-overuse-guard` | integrity / medium | 100% (5/5) |

Wall time 26.3s across 65 cases, 35 LLM calls, 0 errors.

## Tier 1 — suites

| Suite | Score | Cases |
|---|---|---|
| `tools.contract` | 100% | 12/12 |
| `longtask.constants` | 100% | 17/17 |
| `modules.presence` | 100% | 26/26 |
| `security.ssrf` | 100% | 30/30 |
| `agent.write-basic` | 100% | 5/5 |
| `agent.calc-then-write` | 100% | 5/5 |
| `agent.list-then-count` | 100% | 6/6 |
| `agent.read-back-verify` | 100% | 6/6 |
| `agent.constraint-respect` | 100% | 6/6 |
| `agent.recover-from-error` | 100% | 5/5 |
| `agent.calibrated-no-tool` | 100% | 5/5 |
| `agent.calibrated-honest-refusal` | 100% | 5/5 |
| `agent.serial-multi-step` | 100% | 7/7 |
| `agent.sequential-state` | 100% | 5/5 |
| `agent.negative-constraint` | 100% | 5/5 |
| `agent.tool-overuse-guard` | 100% | 5/5 |

## Reproduce

```bash
npm run bench:fast     # deterministic tier-1 only, no tokens
npm run bench          # + live LLM (deepseek by default)
npm run bench:agentic -- --provider=openai --model=gpt-4o-mini --key=sk-...
```

## Design notes

- **No LLM judge.** Every tier-2 assertion is machine-verifiable: exact file bytes,
  a regex over the reply, numeric equality, or the recorded tool-call trace. Swapping
  models changes the score honestly instead of moving the goalposts.
- **Honesty is scored.** Two cases check the model refuses rather than fabricates,
  two check it does not over-use tools. A model that always complies scores lower
  than one that knows its limits.
- **The SSRF suite asserts the real v1.9.2 policy** (block cloud metadata, allow LAN),
  because the agent runs on the user's own machine and must reach a local Ollama.
