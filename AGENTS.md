# AI Gateway Routing — "Best Model for Task Type"

> **Handoff context for a fresh chat.** This project implements task-type-based model
> routing on the **Vercel AI Gateway**. It was split out of a Telegram-digest session to
> keep concerns clean. Read this file top-to-bottom, then continue in `src/router.ts`.

## Goal

Automatically pick the best-suited underlying model per request:

| Tier | When | Optimize for |
|------|------|--------------|
| `fast` | simple text, short prompts | cost/latency |
| `reasoning` | hard analysis, long/complex prompts | quality |
| `vision` | image inputs | multimodal |
| `coding` | code in the prompt | code quality |

## Key finding (verified against Vercel docs)

**Vercel AI Gateway has NO native auto-router.** Unlike OpenRouter's `openrouter/auto`,
it does not classify the request and choose a model for you. It is a *provider/reliability*
layer: fallbacks, provider ordering, cost sorting. So task-type routing is done at the
**application level** — we classify, then hand the gateway an explicit model ID (+ fallbacks).

What the gateway *does* expose (all real, doc-verified):

| Feature | Syntax | Purpose |
|---|---|---|
| Model fallback chain | `providerOptions.gateway.models: [...]` | retry next model on failure |
| Cost sorting | `providerOptions.gateway.sort: 'cost'` | cheapest provider for a model |
| Provider ordering/filtering | `order: [...]`, `only: [...]` | pin/restrict upstream |
| Per-tier budget caps | separate API keys per tier | cost isolation |

Docs used:
- https://vercel.com/docs/ai-gateway
- https://vercel.com/kb/guide/cost-aware-model-routing-with-ai-gateway
- https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
- https://vercel.com/ai-gateway/models (live model catalog)

## Vercel Gateway vs. OpenRouter `openrouter/auto`

`openrouter/auto` (OpenRouter's "Auto Router", historically powered by NotDiamond) is a
single model slug you send everything to; OpenRouter inspects the prompt and dispatches it
to a model it deems best from a curated pool.

| Dimension | Vercel Gateway (this approach) | OpenRouter `openrouter/auto` |
|---|---|---|
| **Model selection** | You classify in code (explicit, deterministic) | Provider-side, automatic, per-request |
| **Transparency** | Full — you know exactly which model + why | Opaque — selection heuristic is theirs; you learn the pick after the fact |
| **Control** | Total — your tiers, your thresholds, your fallbacks | Limited — you accept their routing logic and pool |
| **Determinism** | Same input → same model | Can vary; routing model can change under you |
| **Setup cost** | You write & maintain a classifier | Zero classification code |
| **Vision/code guarantees** | Guaranteed by your rules | Best-effort; no hard guarantee a vision/coding model is chosen |
| **Cost optimization** | `sort:'cost'` + tiered model choice + per-tier keys | Auto-router tries to balance cost/quality, but you can't tune the curve |
| **Fallbacks** | Explicit `models: [...]` chain per tier | Handled internally |
| **Lock-in / portability** | AI SDK standard; swap providers freely | Tied to OpenRouter's router semantics |
| **Best when** | You want predictable, auditable, tunable routing (production, cost governance, compliance) | You want a zero-effort "just make it good" single endpoint and don't need control |

**Bottom line:** `openrouter/auto` optimizes for *convenience*; the Vercel-gateway pattern
here optimizes for *control, transparency, and cost governance*. For a technical user who
wants explicit tiers and auditable behavior, the application-level classifier wins. If you
truly want hands-off dynamic routing, `openrouter/auto` is the closest turnkey option — you
could even register OpenRouter as one gateway provider and treat `openrouter/auto` as the
`fast`/default tier while keeping explicit tiers for vision/coding/reasoning (hybrid).

## Implement / continue here

1. `src/router.ts` — the classifier + tier→model map + gateway fallback wiring (STARTED).
2. `examples/demo.ts` — runnable examples across all four tiers.
3. **VERIFY MODEL IDs FIRST** — the IDs in `router.ts` are plausible but must be confirmed
   against the live catalog before trusting them:
   ```bash
   curl -s https://ai-gateway.vercel.sh/v1/models \
     -H "Authorization: Bearer $AI_GATEWAY_API_KEY" | jq '.data[].id'
   ```
   (Anchor: this account's known-good slug is `anthropic/claude-opus-4.8`.)
4. `AI_GATEWAY_API_KEY` must be set in the environment.

## Open questions to resolve with the user

- Preferred SDK surface: TypeScript (AI SDK) as scaffolded, or Python?
- Which real models per tier (after catalog verification)?
- Hard budget caps per tier (separate keys) — needed?
- Hybrid with `openrouter/auto` as the `fast` tier — of interest?
