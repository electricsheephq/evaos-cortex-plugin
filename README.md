<div align="center">

# 🧠 Cortex

**Persistent, long-term memory for AI agents.**

Your agent remembers who you are, what you've decided, and what matters to you — across every conversation.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-green?style=flat-square)](https://openclaw.ai)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

Cortex is an [OpenClaw](https://openclaw.ai) plugin that gives any AI agent **cognitive memory** — the ability to learn about you over time, recall what's relevant, and build a genuine understanding of your preferences, decisions, and commitments.

This isn't RAG over documents. This is an agent that *knows* you.

## Why Cortex?

- **Learns, doesn't just retrieve.** Every conversation is analyzed. Important facts, preferences, and decisions are automatically extracted and stored. Your agent gets smarter with every interaction.
- **Recalls what matters, when it matters.** Before every agent turn, Cortex retrieves relevant memories using hybrid search (BM25 + vector similarity + reranking) and injects them into context. No manual prompting required.
- **Tracks commitments, not just facts.** Cortex doesn't just remember what you said — it tracks what you committed to, flags contradictions in your preferences, and manages open threads you haven't resolved yet.
- **Runs in the background.** Zero-config by default. Install the plugin, point it at a Cortex server, and your agent has memory. Auto-recall and auto-capture handle the rest.

## Quick Start

**1. Install**

```bash
# From GitHub
cd ~/.openclaw/extensions
git clone https://github.com/100yenadmin/evaos-cortex-plugin.git cortex
cd cortex && npm install --omit=dev
```

**2. Configure** — add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["cortex"],
    "load": { "paths": ["~/.openclaw/extensions/cortex"] },
    "slots": { "memory": "cortex" },
    "entries": {
      "cortex": {
        "enabled": true,
        "config": {
          "cortexUrl": "https://your-cortex-server.example.com",
          "apiKey": "your-api-key",
          "ownerId": "my-agent"
        }
      }
    }
  }
}
```

**3. Restart your gateway.** Your agent now has persistent memory. Every conversation is captured. Every future turn is enriched with relevant context.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cortexUrl` | `string` | `http://localhost:8000` | Cortex API base URL |
| `apiKey` | `string` | — | API key (optional for local, required for production) |
| `ownerId` | `string` | `default` | Memory namespace — isolates memories per user/agent |
| `autoRecall` | `boolean` | `true` | Retrieve relevant memories before each agent turn |
| `autoCapture` | `boolean` | `true` | Extract and store memories after each agent turn |
| `shadowMode` | `boolean` | `false` | Dry-run mode — runs extraction but skips storage |
| `retrievalBudget` | `number` | `2000` | Max token budget for retrieved memories |
| `maxInjectionChars` | `number` | `8000` | Max characters injected into agent context |
| `retrievalMode` | `string` | `fast` | Retrieval mode: `auto`, `fast`, or `thorough` |
| `companyBrainContextMode` | `string` | `off` | Opt-in Company Brain context injection: `off` or `auto` |
| `companyBrainContextAccountId` | `string` | — | Stable account ID for account-scoped Company Brain context |
| `companyBrainContextSearch` | `string` | — | Account search text used when no account ID is configured |
| `companyBrainContextFactsLimit` | `number` | `25` | Max account facts requested for Company Brain context |
| `companyBrainContextEventsLimit` | `number` | `10` | Max action-readiness events requested for Company Brain context |
| `companyBrainContextMaxChars` | `number` | `6000` | Max characters in the Company Brain context block |

## Tools

Cortex exposes memory tools and explicit Company Brain tools your agent can call
directly:

| Tool | Description |
|------|-------------|
| `cortex_search` | Search memories by query — hybrid BM25 + vector retrieval |
| `cortex_remember` | Store a new memory (fact, preference, decision) |
| `cortex_forget` | Delete a specific memory by ID |
| `cortex_ask` | Ask a question answered by searching across all memories |
| `cortex_list_contradictions` | Surface conflicting memories for review |
| `cortex_resolve_contradiction` | Resolve a flagged contradiction |
| `cortex_add_commitment` | Track a new commitment or promise |
| `cortex_update_commitment` | Mark a commitment as completed or cancelled |
| `cortex_list_commitments` | List active (or all) tracked commitments |
| `cortex_add_open_loop` | Track an unresolved thread or topic |
| `cortex_resolve_open_loop` | Mark an open loop as resolved |
| `cortex_list_open_loops` | List unresolved threads |
| `company_brain_accounts_list` | Resolve Company Brain account/workspace IDs |
| `company_brain_account_brief` | Fetch source-backed account facts and action-readiness buckets |
| `company_brain_account_timeline` | Fetch artifact and claim events with citations |
| `company_brain_query` | Ask narrow account-scoped pilot questions with cited evidence |

Company Brain tools are explicit and account-scoped. They call Cortex
`/api/v1/company-brain/*` over HTTP and preserve raw response fields including
`citations`, `verification_status`, `requires_approval`, `action_readiness`,
pagination, and `insufficient_evidence`. They do not inject generic always-on
Company Brain context and they do not write to shared plugin storage.

For customer/account workspaces, `companyBrainContextMode: "auto"` enables a
separate `<company-brain-context>` block. The block is distinct from
`<relevant-memories>`, resolves the account through the Company Brain account
path, preserves cited evidence and action-readiness metadata, and marks
approval-gated items as read-only operator-review candidates rather than
executable actions.

## How It Works

Cortex operates two invisible loops around every agent conversation:

```
┌─────────────────────────────────────────────────┐
│                  RECALL LOOP                     │
│                                                  │
│  User message → Cortex retrieves relevant        │
│  memories (BM25 + vectors + reranking) →         │
│  Injects into agent context → Agent responds     │
│  with full history awareness                     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                  CAPTURE LOOP                    │
│                                                  │
│  Agent responds → Cortex analyzes the            │
│  conversation → Extracts facts, preferences,     │
│  decisions, commitments → Stores as durable      │
│  memories with metadata and embeddings           │
└─────────────────────────────────────────────────┘
```

**Retrieval pipeline:**
1. **BM25** — fast keyword matching for exact terms and names
2. **Vector similarity** — semantic search via embeddings for conceptual matches
3. **Hybrid fusion** — weighted combination of both signals
4. **Reranking** — final relevance scoring to surface the best memories
5. **Budget enforcement** — results trimmed to token budget before injection

Memories include metadata (dates, salience, categories) and are deduplicated, contradiction-checked, and relevance-scored at retrieval time.

## Benchmarks

> 🚧 **Benchmarks coming soon.** We're running evaluations against [LoCoMo](https://github.com/snap-research/locomo), [AMB](https://github.com/microsoft/AMB), and [MSC](https://github.com/facebookresearch/ParlAI/tree/main/projects/msc) — the standard long-term memory benchmarks for conversational AI.

| Provider | LoCoMo F1 | AMB Score | Latency (p50) |
|----------|-----------|-----------|----------------|
| **Cortex** | — | — | — |
| [Mem0](https://github.com/mem0ai/mem0) | — | — | — |
| [Zep](https://github.com/getzep/zep) | — | — | — |
| [Letta](https://github.com/letta-ai/letta) | — | — | — |
| [MemGPT](https://arxiv.org/abs/2310.08560) | — | — | — |

Results will be published with full methodology and reproducible evaluation scripts.

## Self-Hosting

Cortex is backed by a standalone server you can run anywhere — your own machine, a VPS, or any cloud provider. The server handles memory storage, embedding, retrieval, and lifecycle management.

Self-hosting documentation and the server repository will be available soon. In the meantime, [reach out](https://github.com/100yenadmin/evaos-cortex-plugin/issues) if you'd like early access.

## License

[MIT](LICENSE) — use it however you want.
