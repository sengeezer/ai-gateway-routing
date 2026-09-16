# AI Gateway Routing — Task-Type LLM Classifier (Production)

> **Handoff context for fresh sessions.** This project implements task-type-based model routing with a measured, gated embeddings classifier. It's live on Vercel, open-source on GitHub, and reduces credit spend via tiering + local-inference opt-ins.

## Goal

Route requests to the best-suited model per task type: fast (cost/latency), reasoning (quality), vision (multimodal), coding (code quality). Minimize credit spend through intelligent tiering and optional local inference.

## Status: Production

| Aspect | State |
|--------|-------|
| **Classifier** | Embeddings-based (96.7% accuracy on labeled eval set). Regex fallback for offline mode. |
| **Deployment** | Live on Vercel: `https://ai-gateway-routing.vercel.app/api/classify` (protected). Public GitHub repo: `https://github.com/sengeezer/ai-gateway-routing` (MIT). |
| **CI Gate** | Semantic accuracy ≥0.90 enforced on push (uses `AI_GATEWAY_API_KEY` repo secret). Regex gate ≥0.70 on all events. |
| **Fast Tier** | Defaults to OpenRouter's `openrouter/auto`, with opt-ins for Vercel gateway (`openai/gpt-4o-mini`) or local Qwen (`FAST_TIER_PROVIDER=local`). |
| **Access Control** | Vercel Deployment Protection (SSO for humans). Add "Protection Bypass for Automation" secret in dashboard; authorized callers send header `x-vercel-protection-bypass: <secret>`. |

---

## Key Findings (Verified)

### 1. Vercel AI Gateway has no native auto-router
Unlike OpenRouter's `openrouter/auto`, the Vercel gateway is a **provider/reliability** layer (fallbacks, cost sorting). Task-type routing must be done at the **application level** — classify the request, then hand the gateway an explicit model + fallbacks.

### 2. Embeddings-based classification is reliable
- **Regex baseline:** 73.3% overall, 12.5% adversarial (prose containing "class"/"import"/"analyze" misroutes).
- **Embeddings (measured):** 96.7% overall, 100% adversarial. Uses gateway embeddings API + cosine similarity.
- **Fallback:** If embeddings fail (no key/network), uses regex silently. Result includes `method` field for transparency.

### 3. Local inference cuts costs dramatically
Qwen3.6-35B (262k context, vision-capable) runs free on local llama.cpp. **Fast tier can route to local Qwen**, eliminating credits for simple requests. Configured via `FAST_TIER_PROVIDER=local` + `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_API_KEY`/`LOCAL_LLM_MODEL`.

### 4. Spend data is limited
Vercel's detailed spend reports (per-model breakdown) require a paid plan (403/"requires a paid plan"). The `/v1/credits` endpoint gives real-time balance/used but no attribution. **Mitigate:** capture token usage + estimated cost per call, instrument the code.

---

## Architecture

### Tiers → Model chains

```typescript
type Tier = 'fast' | 'reasoning' | 'vision' | 'coding';
const TIER_MODELS = {
  fast: 'openai/gpt-4o-mini',           // or openrouter/auto, or local Qwen
  reasoning: 'anthropic/claude-opus-4.8',
  vision: 'openai/gpt-4o',
  coding: 'anthropic/claude-sonnet-4',
};
```

Fallback chains per tier (e.g. fast → `google/gemini-2.5-flash-lite`, etc.) auto-retry on failure.

### Classification

1. **Embeddings** (default, if `AI_GATEWAY_API_KEY` set):
   - Reference utterances per tier.
   - Embed prompt + references via gateway.
   - Cosine similarity → highest-scoring tier.
   - **Confidence:** inspect the similarity gap; tie-break rules available.

2. **Regex** (fallback, free, offline):
   - Keywords: `def`/`import`/`function` → `coding`; `image` → `vision`; etc.
   - Thresholds & heuristics tuned for 73.3% accuracy on eval set.

### Fast-Tier Toggle

Four levels of precedence (first match wins):
1. **Per-call:** `routedGenerate({ prompt, fastProvider: 'local' })`
2. **Programmatic:** `setFastTierProvider('openrouter')`
3. **Env:** `FAST_TIER_PROVIDER=gateway|openrouter|local`
4. **Default:** `openrouter`

### Endpoint Protection

```
GET/POST /api/classify
  Body: { prompt: string; images?: string[] }
  Headers: x-vercel-protection-bypass: <secret> (if SSO is enabled)
  Returns: { tier, provider, model, method } or 400
```

Status: **401 when Vercel Deployment Protection is active without the bypass secret.** Enable the secret in `Project → Settings → Deployment Protection → Protection Bypass for Automation`.

### Credit Warnings (not caps)

```typescript
const { balance, used } = await getCredits(provider);
if (balance < 50) warn('Low credits on gateway:', balance);
if (balance < 20) warn('Critical credits on gateway:', balance);
```

Warnings are logged; no request is denied. Quality trumps speed and cost.

---

## Files & Responsibilities

| File | Purpose |
|------|---------|
| `src/router.ts` | Main classifier + tier→model map + async resolver. Exports: `classify()`, `classifyAsync()`, `modelForInput()`, `routedGenerate()`, `setFastTierProvider()`. |
| `src/semantic-classifier.ts` | Embeddings logic: reference utterances, cosine similarity, configurable via `CLASSIFIER` + `EMBED_MODEL`. |
| `src/credits.ts` | Credit balance checks + low-balance warnings for gateway + OpenRouter. |
| `api/classify.ts` | Vercel Function (Web handler). Pure classification endpoint, no model generation. Protected by Deployment Protection. |
| `eval/dataset.ts` | 30 labeled prompts (30% adversarial cases). Ground truth for evaluation. |
| `eval/run-eval.ts` | Regex baseline scorer (73.3% floor). |
| `eval/run-eval-semantic.ts` | Embeddings gate (96.7%, ≥0.90 floor). Run via CI on push only. |
| `eval/compare.ts` | Head-to-head: embeddings vs regex. |
| `.github/workflows/ci.yml` | TypeCheck + 29 tests (all tiers). Semantic eval on push (guarded: skip if secret absent). |
| `tests/router.test.ts`, `tests/credits.test.ts` | 29 integration + unit tests. Hermetic (clear env in beforeEach). |
| `examples/demo.ts` | Dry-run routing table (no API calls). |
| `examples/live-e2e.ts` | Live generation across all four tiers. Requires keys. |
| `README.md` | Quick start, accuracy numbers, tier descriptions, local-inference guide. |
| `TODO.md` | Backlog: app-level API keys, reason-2 misroute, vision tier for Qwen, stable local endpoint, reasoning downgrade, per-request cost instrumentation. |

---

## Environment Variables

```bash
# Required
AI_GATEWAY_API_KEY=sk-...           # Vercel AI Gateway
OPENROUTER_API_KEY=sk-...           # OpenRouter (if using openrouter/auto)

# Optional
FAST_TIER_PROVIDER=openrouter|gateway|local  # default: openrouter
CLASSIFIER=auto|semantic|regex               # default: auto (embeddings if key, else regex)
EMBED_MODEL=text-embedding-3-small           # default: configured in semantic-classifier.ts

# Local inference (FAST_TIER_PROVIDER=local)
LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_LLM_API_KEY=local
LOCAL_LLM_MODEL=Qwen3.6-35B-A3B
```

---

## Quick Start

```bash
# Install
npm install

# Typecheck
npm run typecheck

# Test (offline, 29 tests)
npm run test

# Dry-run classifier (no API calls)
npm run demo

# Evaluate regex baseline
npm run eval

# Evaluate embeddings (requires AI_GATEWAY_API_KEY)
npm run eval:semantic

# Compare head-to-head
npm run eval:compare

# Live end-to-end (all tiers, requires keys)
npm run e2e
```

---

## Known Issues & Backlog

### Fixed recently
- ✓ Regex baseline misroutes on adversarial prose (class/import/analyze). Embeddings solves this (100% adversarial accuracy).
- ✓ Vercel deploy ERESOLVE: Rewrote to Web handler, dropped `@vercel/node` dep.
- ✓ CLI tests were not hermetic (env leakage). Added `beforeEach` cleanup.

### Open
1. **Math proofs → `coding`** (`reason-2` in eval set). Embeddings pull math-proof text toward the coding centroid. Mitigation: add math reference utterances to reasoning tier (keep disjoint from eval set), or tie-break rule. Re-evaluate: must stay ≥96.7% overall.
2. **Local endpoint stability.** Hermes's internal llama-server uses rotating ports + keys. Point `LOCAL_LLM_BASE_URL` at a stable endpoint (dedicated instance or OmniRoute gateway `:20128`).
3. **Reasoning tier too expensive.** `claude-opus-4.8` is top-of-market priced. Reserve for hard cases; default most to `claude-sonnet-4` + opt-in escalation.
4. **Spend not instrumented.** Capture token usage + estimated cost per call; log for analysis. Enables credit tuning without the paid Vercel dashboard.
5. **Vision tier for Qwen.** Qwen3.6-35B has vision projector (mmproj) + 262k context. Evaluate as a free vision alternative or cheap reasoning fallback.

---

## Deployment & Access

### Vercel (live)
- URL: `https://ai-gateway-routing.vercel.app/api/classify`
- **Protected:** Vercel Deployment Protection + SSO. Add "Protection Bypass for Automation" secret to allow authorized API callers.
- See `.github/workflows/ci.yml` for live accuracy gate (semantic eval on push).

### GitHub (public, MIT)
- Repo: `https://github.com/sengeezer/ai-gateway-routing`
- All code, tests, eval harness, CI/CD are open. Others can fork and adapt.
- Latest: `eval/run-eval-semantic.ts` integrated into CI; local Qwen route added.

---

## For Next Hands-Off

1. **Immediate:** App-level API-key check in `api/classify.ts` (second layer, independent revocation). See `TODO.md#requested`.
2. **Short-term:** Fix reason-2 misroute (math proofs → coding). Re-run eval; confirm ≥96.7%.
3. **Medium-term:** Route more tiers to local Qwen (vision, reasoning fallback). Measure credit savings.
4. **Long-term:** Per-request cost instrumentation (token usage + attribution). Feed into tier tuning.

---

## Reference Docs

- **Vercel AI Gateway:** https://vercel.com/docs/ai-gateway, https://vercel.com/ai-gateway/models
- **Vercel Protection Bypass:** https://vercel.com/docs/deployments/deployment-protection
- **AI SDK v5:** https://sdk.vercel.ai (generateText, embedMany, gateway provider)
- **Eval harness:** `npm run eval:semantic` (uses published eval set + measured thresholds)

---

## Anchor for Triage

- **Credit burn (high priority):** Local Qwen route is wired. Test stability of `LOCAL_LLM_BASE_URL` endpoint (rotating ports in Hermes). Consider dedicated instance or OmniRoute.
- **Reasoning tier (medium):** Audit whether `claude-opus-4.8` is actually needed for most reasoning requests. Downtier default; add escalation.
- **Spend visibility (medium):** Detailed reports are a paid feature. Capture `providerMetadata.gateway` + token usage to instrument cost per call.
- **Endpoint gating (low):** Protection Bypass is live. App-level key layer is TODO but optional (second layer of auth).
