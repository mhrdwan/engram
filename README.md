# 🧠 Engram

**The self-maintaining memory layer for coding agents.**
Persistent, token-frugal, *self-invalidating* memory — served straight into your agent over MCP.

> *The best context is the context your agent never has to re-read.*

Engram gives Claude Code (and any MCP client) a long-term memory that **remembers across sessions**, **injects itself at session start**, and — uniquely — **knows when its own facts go stale** and **evicts memories by how many tokens they actually save**. It is not a note app you maintain; it maintains itself.

---

## Why Engram exists

Coding agents burn tokens re-learning your project **every single session** — re-reading the README, re-grepping the source, re-deriving the same architecture facts. Existing "AI memory" tools store facts but:

- they go **stale** silently (the code changed; the stored fact is now a lie — worse than no memory), and
- they **bloat** — every remembered note costs tokens forever, whether it ever helps or not.

Engram fixes both with **living memory**.

---

## What makes Engram different — *living memory*

Two capabilities no other local memory tool has:

### 1. Self-invalidating memory 🔎 (cache invalidation for facts)
Anchor a memory to the file it came from. Engram stores a hash of that file. On recall, it re-checks the file — if it changed, the fact is flagged **`⚠️ STALE`** so the agent re-verifies instead of trusting an outdated fact.

```jsonc
// remember
{ "content": "Auth service listens on port 3001", "type": "fact", "anchor": "be/services/auth/main.ts" }
// later, after that file changed →  recall returns:
// 1. ⚠️ STALE [fact] Auth service listens on port 3001 (2026-08-16)
```

### 2. Token-ROI ledger 💰 (evict by value, not by age)
Every memory keeps a running ledger: **tokens_saved** (credited each time it's recalled and spares a re-derivation) vs **tokens_spent** (the cost of carrying/injecting it). Pruning evicts **pure-cost** memories first and protects **high-ROI** ones — the store keeps only what pays for itself.

```
ROI ledger: saved ~4,120 tok · spent ~380 tok · net ~3,740 tok
Anchored: 12 (self-invalidating) · Stale now: 1 ⚠️
```

**Result:** memory that *cleans itself by value* and *corrects itself by staleness* — not a pile of dead notes.

### 3. Zero-config auto-save 💾 (deterministic, no LLM, works for every user)
A shell hook can't summarize a conversation — it can't see it. But it *can* capture what's provable. `engram init` installs a **`SessionEnd`** hook running `engram capture`: at the end of each session it parses the transcript and writes **one compact record** of what actually happened — files edited, commands run, commits made — with **zero LLM calls, zero API keys, zero tokens**.

```
Last session: [auto] add auto-save capture — edited 2 file(s): capture.ts, index.ts — 2 cmd(s) — commits: feat: auto-capture
```

**Token-frugal by construction:** it fires **once per session** (not per turn), skips sessions that changed nothing, dedups repeats, and relies on the ROI ledger above to keep the store — and every future load — bounded. The semantic *why* stays the model's job via `session_summary`; this just guarantees a floor of memory even when the model forgets.

---

## How it works

```
Claude Code / any MCP client
        │  (MCP tools + SessionStart/SessionEnd hooks)
        ▼
   Engram server (Node, stdio)
        │
        ├── SQLite (better-sqlite3)         ← single unified store, ~/.engram/memory.db
        ├── FTS5 keyword index              ← fast lexical recall + always-on fallback
        ├── local vectors (all-MiniLM-L6)   ← semantic recall (@xenova/transformers, on-device)
        └── anchor hashes + ROI ledger      ← living memory
```

- **One unified DB**, partitioned by `project`; `global` memories are visible everywhere.
- **Hybrid RAG**: semantic (vectors) + lexical (FTS5), reranked by relevance, recency, access, and type. If the embedding model is unavailable it **degrades to keyword-only** instead of failing.
- **Auto-load**: a `SessionStart` hook injects the top memories + last session summary at the start of every session — no tool call, no re-reading files.
- **Auto-save**: a `SessionEnd` hook (`engram capture`) writes one compact, deterministic session record at the end — files edited, commands run, commits — no LLM, no tokens.
- **100% local & private.** No network, no API keys. The embedding model runs on-device.

### MCP tools

| Tool | What it does |
|---|---|
| `remember` | Store a fact/decision/bug/preference. Optional `anchor` → self-invalidating. Auto-dedups. |
| `recall` | Hybrid semantic + keyword search. Marks `⚠️ STALE` results. Compact output (hides IDs by default). |
| `list_memories` | List by type/tag/scope. |
| `forget` | Delete by ID. |
| `session_summary` | Save an end-of-session trail for your future self. |
| `context_status` | `load` (inject context) · `stats` (ROI ledger + stale count) · `prune` (evict by value). |

---

## Quick start

```bash
git clone <this-repo> engram && cd engram
npm install
npm run build
npm install -g .        # exposes `engram` / `engram-mcp`
engram init             # registers the MCP server + installs the SessionStart auto-load hook
```

`engram init` wires up Claude Code (`~/.claude.json`), Claude Desktop, and OpenCode automatically, and installs the auto-load hook in `~/.claude/settings.json`. Restart your agent and it will start each session already remembering.

### Config (env)

| Var | Meaning |
|---|---|
| `ENGRAM_DB` | Override the store path (default `~/.engram/memory.db`). |
| `ENGRAM_PROJECT` | Override the project key (default: folder basename). |
| `ENGRAM_NO_EMBED=1` | Keyword-only mode (skip the vector model — fastest, offline-safe). |

> Upgrading from `cacheAI`? Engram auto-migrates your old `~/.cacheai` store and model cache on first run. `CACHEAI_*` env vars still work as fallbacks.

---

## Where Engram sits vs everything else

These tools are often lumped together, but they attack **different costs**. Engram is the **memory layer** — and the only one that is self-maintaining.

### Capability matrix

| Capability | **Engram** | mem0 / Zep | Pieces | Claude memory | graphify | RTK | ponytail | Obsidian |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Persistent memory across sessions | ✅ | ✅ | ✅ | ✅ | ⚠️ graph | — | — | ✅ manual |
| Semantic + keyword recall | ✅ | ✅ | ✅ | ⚠️ | ✅ | — | — | ⚠️ plugin |
| Runs *inside* the agent (MCP/native) | ✅ | ⚠️ SDK | ⚠️ app | ✅ | ✅ | ✅ hook | ✅ hook | — |
| Auto-injects context at session start | ✅ | — | — | ⚠️ | — | — | — | — |
| **Self-invalidating (stale detection)** | ✅ | — | — | — | — | — | — | — |
| **Token-ROI eviction (value, not age)** | ✅ | — | — | — | — | — | — | — |
| Zero manual curation | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | — |
| Fully local & private | ✅ | ⚠️ | ⚠️ | — | ✅ | ✅ | ✅ | ✅ |
| Compresses command **output** | — | — | — | — | — | ✅ | — | — |
| Reduces **code** written | — | — | — | — | — | — | ✅ | — |
| Builds a knowledge **graph** | ⚠️ roadmap | — | — | — | ✅ | — | — | ⚠️ |

✅ = core capability · ⚠️ = partial/indirect · — = not its job

### Complements, not competitors

Engram is designed to **stack** with the tools that own other cost buckets:

- **RTK** compresses *command output* (in-session). Engram remembers *knowledge* (cross-session). → run both.
- **ponytail** makes the agent *write less code* (generation side). Orthogonal to memory.
- **graphify** *structures* a codebase into a graph. Engram can anchor memories to it (roadmap).
- **Obsidian** is for *humans* to curate notes by hand. Engram is for *agents* and curates itself.

---

## Benchmarks (real numbers)

Token cost **per session**, `estimate = ceil(bytes/4)`. Reproduce with the scripts in `benchmark/`.

**Small repo (knowledge-heavy session)** — `benchmark/four-way.mjs`

| | Naked | RTK | Engram | RTK+Engram |
|---|--:|--:|--:|--:|
| TOTAL / session | 33,866 | 28,311 | 12,460 | **6,905** |
| Saving vs naked | — | 16% | 63% | **80%** |

**Large monorepo — NEUROX / 1,337 files (command-heavy session)** — `benchmark/four-way-neurox.mjs`

| | Naked | RTK | Engram | RTK+Engram |
|---|--:|--:|--:|--:|
| TOTAL / session | 24,639 | 12,846 | 17,492 | **5,699** |
| Saving vs naked | — | 48% | 29% | **77%** |

The winner **flips by workload** — RTK dominates command-heavy sessions, Engram dominates knowledge-heavy ones — but **RTK + Engram always wins** (77–80%). On a big repo, if the agent actually re-reads source (~2.1M tokens for NEUROX) instead of onboarding docs, Engram's saving approaches **~99.97%**.

**Onboarding recall vs re-reading** — `benchmark/token-compare.mjs`: 306 tokens (recall) vs 3,998–16,252 tokens (re-read) → **92–98%** per session.

---

## Development

```bash
npm run build      # tsc → build/
npm test           # vitest (29 tests: reliability, dedup, migration, living-memory)
```

Tests run file-serially (`fileParallelism: false`) because each imports the on-device model runtime.

---

## Roadmap

- Knowledge-graph edges between memories (god-nodes / community summaries).
- `recall`-first guard: skip an expensive command when the answer is already remembered.
- Shared/team memory with per-fact confidence.
- Proof-carrying memory: a memory carries a cheap verification command it self-runs on recall.

---

## License

MIT — © Engram contributors. Built by evolving `cacheAI` into a self-maintaining memory layer.
