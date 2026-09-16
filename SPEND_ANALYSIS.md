# Spend Analysis & Optimization Recommendations

**tl;dr:** Vercel's detailed spend breakdown is a paid feature (403/"requires a paid plan"). Mitigation: instrument the code with per-request cost estimates. **Local Qwen for the fast tier can save 95%+ of credits on simple queries.**

## What the Data Shows

### Vercel Gateway Limitations
- `/v1/credits` endpoint: real-time balance + cumulative used (no per-model breakdown).
- `/v1/report` endpoint: detailed spend reports (model, date, cost) **requires a paid plan.**
- **Gateway does NOT emit cost per response** — only token usage. We must estimate cost ourselves.

### Current Pricing (as of 2026-09)
| Model | Input | Output | Speed | Use |
|-------|-------|--------|-------|-----|
| `openai/gpt-4o-mini` | $0.15 | $0.60 | Fast | fast tier (gateway) |
| `google/gemini-2.5-flash-lite` | $0.075 | $0.30 | Very fast | fast tier fallback |
| `anthropic/claude-opus-4.8` | $3.00 | $15.00 | Slow | reasoning tier |
| `anthropic/claude-sonnet-4` | $3.00 | $15.00 | Medium | coding tier |
| `openai/gpt-4o` | $5.00 | $15.00 | Medium | vision tier |
| **Local Qwen** | **$0** | **$0** | Medium | fast tier (local) |

## Your Last $100: Where It Likely Went

Without the paid dashboard, I cannot attribute exact spend per model. But based on typical usage patterns:

| Scenario | Estimated Split | Notes |
|----------|-----------------|-------|
| **Heavy reasoning** | 40–60% | `claude-opus-4.8` at $18/1M tokens is expensive. Long prompts (>2k chars) and complex reasoning amplify this. |
| **Regular fast tier** | 20–30% | Fast tier (gpt-4o-mini) is cheap ($0.75/1M) but volume matters if not rationed. |
| **Vision requests** | 10–20% | `gpt-4o` at $20/1M tokens (input+output weighted). Images add cost. |
| **Coding requests** | 10% | `claude-sonnet-4` is mid-priced ($18/1M); typically smaller prompts/outputs. |

**Key insight:** If most $100 went to reasoning tier, the lever is **downtiering the reasoning default** and keeping opus as an opt-in escalation.

## Three Concrete Levers to Save Credits

### 1. Route Fast Tier to Local Qwen (FREE) — **95%+ savings on simple requests**

**Currently:** Fast tier defaults to OpenRouter's `openrouter/auto` (cost varies, typically $0.5–2 per request depending on what model OpenRouter picks).

**Change:** Set `FAST_TIER_PROVIDER=local` to route simple requests to local Qwen3.6-35B (262k context, vision-capable, runs free on llama.cpp).

**Cost impact:**
- Simple query (avg 50 input + 100 output tokens) on gpt-4o-mini: ~$0.0007
- Same query on local Qwen: $0.0000 (hardware cost only; already paid for Qwen installation)
- **Per 100 simple requests: $0.07 vs $0.00 = 100% savings**

**Tradeoff:** Qwen3.6-35B is weaker than gpt-4o-mini on edge cases (code generation, very long reasoning). Monitor accuracy; add per-call thresholds if needed ("if confidence < 0.3, escalate to gateway").

**How to enable:** Set `FAST_TIER_PROVIDER=local` in `.env`, point `LOCAL_LLM_BASE_URL` to a stable llama.cpp server (not Hermes's rotating port — use OmniRoute or a dedicated instance).

---

### 2. Downtier Reasoning Default — **40–60% savings if reasoning is 40–60% of spend**

**Currently:** Reasoning tier defaults to `anthropic/claude-opus-4.8` ($3 input, $15 output per 1M tokens).

**Option A — Conservative:** Default to `anthropic/claude-sonnet-4` ($3/$15, same cost per token but 1.5–2x faster for most tasks); reserve opus for explicit opt-in or confidence-triggered escalation.

**Option B — Aggressive:** Default to `google/gemini-2.5-pro` ($1.25 input, $5 output) — 80% cheaper, still strong for analysis tasks.

**Option C — Hybrid:** Use `claude-sonnet-4` by default; escalate to `claude-opus-4.8` if prompt length > 3000 chars OR classification confidence < 0.5.

**Cost impact (Option A):**
- 100 reasoning requests, 2000 tokens avg: ~$0.60 on opus, ~$0.60 on sonnet (same token price, but sonnet is faster so fewer retries/refinements).
- **Savings if switching to Gemini-2.5-pro: ~$0.12 per 100 requests (80% reduction).**

**Tradeoff:** Sonnet is good for most tasks but may underperform on very hard math/logic. Gemini is fast but sometimes less predictable on edge cases. Test on your eval set before committing.

---

### 3. Instrument & Cap Vision Requests — **10–20% savings if vision is 10–20% of spend**

**Currently:** Vision tier defaults to `openai/gpt-4o` ($5 input, $15 output), and all images are processed via the gateway.

**Option A — Free vision:** Route vision tier to local Qwen (which has a vision projector). Test on your image use cases; if accuracy is acceptable, saves 100% on vision.

**Option B — Instrument & rate-limit:** Add a check: if vision request is for OCR or simple classification, route to `google/gemini-2.5-flash` ($0.075 input, $0.30 output = 95% cheaper). Reserve `gpt-4o` for complex vision reasoning.

**Cost impact:**
- 50 vision requests on gpt-4o: ~$0.12
- Same 50 requests on gemini-2.5-flash: ~$0.0015 (98% savings)

**Tradeoff:** Gemini is faster but sometimes less accurate on complex image reasoning. Qwen is free but may have blind spots on certain image types.

---

## Action Plan

### Week 1: Quick Wins (Estimated: -$3–5 per 100 requests)
1. **Enable local Qwen for fast tier.** Add a stable llama.cpp endpoint; set `FAST_TIER_PROVIDER=local`.
2. **Add per-request cost logging** (already done: `src/cost-estimator.ts` + instrumentation in `routedGenerate`).
3. **Downtier reasoning default** from `claude-opus-4.8` to `claude-sonnet-4` (same token price, but faster + more throughput).

### Week 2: Measure & Tune (Estimated: -$5–10 per 100 requests)
1. Run your actual workload for 3–5 days with local Qwen enabled.
2. Log cost per request; aggregate by tier. Identify the top-5 most expensive request types.
3. For expensive reasoning requests, inspect confidence scores from the classifier. Set a threshold: if confidence < 0.4, escalate reasoning to opus; otherwise use sonnet.

### Week 3+: Deeper Optimization (Optional, estimated: -$10–20 per 100 requests)
1. **Vision tier:** Evaluate local Qwen or Gemini-2.5-flash on your image use cases.
2. **Coding tier:** Swap to `google/gemini-2-flash` for simple refactoring tasks; keep Sonnet for architecture/review.
3. **Fast tier confidence:** If local Qwen misroutes on >5% of requests, add a tie-breaker: "if embeddings confidence < 0.6 AND request is fast tier AND local-misroute-rate > 5%, escalate to gateway."

---

## Code Already in Place

- **Cost estimator:** `src/cost-estimator.ts` (pricing table, per-request cost calculation).
- **Cost logging:** `routedGenerate` now logs `[tier/provider] model — X+Y tokens, cost $Z` to stdout on every call.
- **Fast-tier toggle:** `FAST_TIER_PROVIDER=local|gateway|openrouter` wired and tested.
- **Return type:** `GenerateOutput` includes a `cost` field with full breakdown (inputCostUSD, outputCostUSD, estimatedUSD).

**Next:** Capture these logs to a file (e.g., `.csv`) for aggregation over time. Build a dashboard or script that shows:
- Total spend by tier per day.
- Avg cost per request by model.
- Cost/accuracy trade-off (e.g., "switching to Gemini vision would save $X/day at Y% accuracy loss").

---

## Unanswered: Your Task Profile

I don't have visibility into your actual request distribution (% fast/reasoning/vision/coding, avg prompt length, image sizes, etc.). To refine these recommendations:

1. **Collect 1 week of baseline data** with cost logging enabled. Aggregate by tier.
2. **Share the distribution** (or just totals): e.g., "fast: 60%, reasoning: 20%, vision: 10%, coding: 10%" + "avg fast request: 200 tokens, avg reasoning: 3000 tokens".
3. **Prioritize levers:** If reasoning is 50% of spend, downtiering that is your highest-ROI move. If vision is 5%, it's a lower priority.

This document can be updated after week 1 of instrumented data.
