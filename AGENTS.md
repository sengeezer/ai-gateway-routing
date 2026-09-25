# AI Gateway Routing — Task-Type LLM Classifier

> **Handoff context for fresh sessions.** Task-type-based model routing on the Vercel AI Gateway with a regex classifier, an embeddings classifier, and a new off-by-default Jev shadow classifier under provisional evaluation. Quality-first: cost is a warning signal, never a cap.

## Goal

Route requests to a tier (fast / reasoning / vision / coding), then to a per-tier model. The per-tier static model policy is a **starting hypothesis, not a proven best-per-task-type choice** — no per-tier response-quality measurement exists yet. Minimize credit spend through tiering and warnings, never through silent downgrades.

## Status: code complete, evaluation provisional

| Aspect | State |
|--------|-------|
| **Classifiers** | Regex (free/offline, CI gate). Embeddings (default in `routedGenerate` when `AI_GATEWAY_API_KEY` present; regex fallback). Jev (off-by-default shadow; see below). |
| **Test suite** | Run `npm run check` for the current count; the original "29 tests" figure is stale. |
| **Deployment** | Vercel project exists; `FAST_TIER_PROVIDER=openrouter` is set in Production, Preview, and Development (value encrypted in dashboard). **No deployed behavior — including fast-tier generation — has been tested live.** `api/classify.ts` is regex-only classification with no generation. |
| **Fast Tier** | Built-in default `openrouter`. Legacy OpenRouter Auto (`openrouter/auto`) is **deprecated upstream** (Auto Beta `openrouter/auto-beta` exists) — this project keeps the stable legacy slug and does not silently switch to beta. |
| **Holdout** | **Sealed.** 40 pilot holdout cases have provisional labels only; no predictions, no human adjudication. |
| **Docs honesty** | Price tables are hardcoded (2026-09) and go stale; unknown model ⇒ estimated $0 rendered as "(free)" — unknown cost is not free. |

---

## Verified Findings

### 1. Vercel AI Gateway has no native auto-router
Unlike OpenRouter's Auto Router, the Vercel gateway is a **provider/reliability** layer (fallbacks, cost sorting). Task-type routing must be done at the **application level** — classify the request, then hand the gateway an explicit model + fallbacks.

### 2. Classifier accuracy — in-sample vs pilot
- **Regex baseline:** ~73.3% overall, ~12.5% adversarial on `eval/dataset.ts` (free, offline, CI gate ≥0.70).
- **Embeddings:** 100% (30/30) on the earlier **tuned 30-case set** — the set the classifier was tuned against. **Not a holdout**; in-sample only. Regex fallback is silent; the result carries a `method` field.
- **Jev (provisional):** 53/60 routing agreement on the 60-case validation split — see §4.

### 3. Fast-tier provider — built-in, hosted
Precedence: per-call `fastProvider` → `setFastTierProvider()` → `FAST_TIER_PROVIDER=gateway|openrouter|local` → built-in default `openrouter`. The Vercel project sets `FAST_TIER_PROVIDER=openrouter` (Production/Preview/Development). The `local` path (OpenAI-compatible server) is **opt-in legacy only** — no local server is part of the intended setup; do not recommend local-first setups.

### 4. Jev pilot — provisional, no adjudication
`src/jev-classifier.ts` asks TypeSafe's Jev model to pick `fast | reasoning | coding | abstain` (**no vision option**), returning a validated typed judgment with full probabilities. It never routes live traffic and never falls back silently.

- **Transports** (`JEV_TRANSPORT`, default `direct`): `direct` → `https://api.typesafe.ai`, model pinned `jev-1.13.0`, key `TYPESAFE_API_KEY`; `gateway` → `https://ai-gateway.vercel.sh/typesafe`, model `typesafe-ai/jev`, key `AI_GATEWAY_API_KEY`. Both speak the TypeSafe v1 `POST /v1/systemone` shape; responses are schema-validated identically.
- **Budgets:** 8s/attempt, 1 retry, 15s total deadline.
- **Pilot dataset** (`eval/pilot-dataset.ts`): 100 provisional (agent-authored) cases, split **60 validation / 40 holdout**. No human adjudication has occurred.
- **Live shadow runs** (`JEV_TRANSPORT=gateway npx tsx eval/shadow-compare.ts --live --json`, validation split, provisional labels): regex **36/60**, embeddings **45/60**, Jev policy **53/60** — **zero failures** across all three comparators. Five vision decisions were deterministic image rules, not Jev requests; Jev model-only routing agreement was **48/55**. Confidence + full distribution are recorded for the 55 text-model rows.
- **Confidence is not calibrated.** Jev's confidence/`probabilities` are raw model output; selective-accuracy and calibration tables are computed but unvalidated. Do not quote them as probabilities.
- **Routing agreement only.** None of these numbers measures response quality of the routed model. The holdout was never touched and stays sealed until an adjudicated artifact exists (`eval/holdout-adjudicated.json` with `{ adjudicated: true, labels }`).

### 5. Cost estimation honesty
- `src/cost-estimator.ts` prices are **hardcoded, dated 2026-09** — they go stale; re-verify against gateway docs.
- A model missing from the table estimates `$0`, and `formatCost()` renders it `(free)`. **Unknown cost is not free.**
- `openrouter/auto`'s price entry is a conservative guess, not OpenRouter's actual rate.
- `src/credits.ts` warns on low balances; never caps or downgrades. Quality trumps cost.

### 6. Spend data is limited
Vercel's per-model spend breakdown requires a paid plan (403). `/v1/credits` gives balance/used with no attribution. Mitigate with per-call token usage + cost instrumentation.

---

## Architecture

### Tiers → Model chains (static policy — hypothesis, not proven best)

```typescript
type Tier = 'fast' | 'reasoning' | 'vision' | 'coding';
const TIER_MODELS = {
  fast: 'openai/gpt-4o-mini',           // when provider = gateway
  reasoning: 'anthropic/claude-opus-4.8',
  vision: 'openai/gpt-4o',
  coding: 'anthropic/claude-sonnet-4',
};
```

Fallback chains per tier auto-retry on failure. `TIER_PROFILE=budget` swaps in cheap/free hosted models (`amazon/nova-micro`, `alibaba/qwen3.7-flash`, `alibaba/qwen3-coder-30b-a3b`, free fallbacks like `inclusionai/ling-3.0-flash-vl-free`). Default profile is `quality`. Budget prices in code are 2026-09 snapshots — verify before trusting.

### Classification

1. **Embeddings** (default when `AI_GATEWAY_API_KEY` set): reference utterances per tier, `embedMany` via the gateway, max cosine similarity; vision stays a hard rule. Fallback to regex on error; `method` field reports which ran.
2. **Regex** (fallback, free, offline): keyword heuristics; the CI gate.
3. **Jev** (shadow only): TypeSafe model choice over `fast/reasoning/coding/abstain`, explicit `abstain` on ambiguity, errors surfaced as counted failures.

### Fast-Tier Toggle (four levels, first match wins)

1. Per-call: `routedGenerate({ prompt, fastProvider: 'openrouter' })`
2. Programmatic: `setFastTierProvider('gateway')`
3. Env: `FAST_TIER_PROVIDER=gateway|openrouter|local`
4. Built-in default: `openrouter`

### Public endpoint

```
POST /api/classify   Body: { prompt, hasImages?, forceTier?, fastProvider? }
Returns: { tier, provider, model } | 400
```

**Regex-only classification. No model call, no generation.** Live generation is not exposed publicly.

---

## Files & Responsibilities

| File | Purpose |
|------|---------|
| `src/router.ts` | Classifier selection, tier→model maps + fallback chains, fast-tier resolver. Exports `classify()`, `classifyAsync()`, `modelForInput()`, `routedGenerate()`, `setFastTierProvider()`. |
| `src/semantic-classifier.ts` | Embeddings classifier (`CLASSIFIER`, `EMBED_MODEL`). |
| `src/jev-classifier.ts` | Off-by-default Jev shadow adapter: transports, pinned model, budgets, typed result, error kinds. |
| `src/credits.ts` | Credit balance checks + low-balance warnings (never caps). |
| `src/cost-estimator.ts` | Hardcoded-price cost estimates. Unknown model ⇒ $0 (**not** free); prices dated 2026-09. |
| `api/classify.ts` | Vercel Function. Pure regex classification endpoint; no generation. |
| `eval/dataset.ts` | Earlier tuned 30-case labeled set (in-sample; not a holdout). |
| `eval/pilot-dataset.ts` | 100 provisional cases: 60 validation / 40 holdout (sealed, no adjudication). |
| `eval/run-eval.ts` | Regex baseline scorer. |
| `eval/run-eval-semantic.ts` | Embeddings scorer (on the tuned set). |
| `eval/compare.ts` | Head-to-head embeddings vs regex on the tuned set. |
| `eval/shadow-compare.ts` | Offline-first three-way shadow harness (regex/embeddings/Jev). Holdout refused without an adjudicated artifact; no writes; no prompt text in rows. |
| `eval/shadow-metrics.ts` | Accuracy/Wilson, macro-F1, confusion, latency, selective, calibration. |
| `tests/*.test.ts` | Offline unit/contract tests; run `npm run test` for the current count. |
| `examples/demo.ts` | Dry-run routing table (no API calls). |
| `examples/live-e2e.ts` | Live generation across all four tiers. Requires keys. |

---

## Environment Variables

```bash
# Required (per provider you actually use)
AI_GATEWAY_API_KEY=          # Vercel AI Gateway
OPENROUTER_API_KEY=          # OpenRouter fast tier (legacy openrouter/auto)
TYPESAFE_API_KEY=            # Jev direct transport (only if not using gateway)

# Optional
FAST_TIER_PROVIDER=openrouter|gateway|local  # default openrouter; set to openrouter on Vercel (all envs)
TIER_PROFILE=quality|budget                  # default quality
CLASSIFIER=auto|semantic|regex               # default auto (embeddings if key, else regex)
EMBED_MODEL=openai/text-embedding-3-small
JEV_TRANSPORT=direct|gateway                 # default direct
TYPESAFE_BASE_URL=                           # override for the direct TypeSafe API

# Local inference — LEGACY, opt-in only. No local server is part of the intended setup.
# LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
# LOCAL_LLM_API_KEY=
# LOCAL_LLM_MODEL=
```

Never put secret values in this file, the README, or code.

---

## Quick Start

```bash
npm install
npm run typecheck
npm run test        # offline; reports current test count
npm run demo        # dry-run routing table
npm run eval        # regex baseline
npm run eval:semantic   # embeddings on tuned set (needs key)
npm run eval:compare    # head-to-head on tuned set

# Shadow comparison (Jev pilot)
npx tsx eval/shadow-compare.ts            # offline: regex only, validation split
npx tsx eval/shadow-compare.ts --live     # + embeddings + Jev (needs keys)
JEV_TRANSPORT=gateway npx tsx eval/shadow-compare.ts --live

npm run e2e        # live generation across tiers (needs keys)
```

---

## Known Issues & Backlog

### Evaluation (highest priority)
1. **Adjudicate the pilot.** All 100 pilot labels are provisional. Adjudicate the 40 holdout cases first (human review → `eval/holdout-adjudicated.json` with `adjudicated: true` + labels), then and only then run `npx tsx eval/shadow-compare.ts --live --holdout`.
2. **Calibrate Jev confidence.** Jev's confidence/distribution is unvalidated; a calibrated gate (selective accuracy/coverage) is the next measurement step.
3. **Response quality is unmeasured.** Routing-agreement numbers say nothing about the routed models' outputs; static tier policy is unproven.
4. **Prices drift.** `src/cost-estimator.ts` table (2026-09) is stale-prone; unknown models estimate $0 and render "(free)" — treat as unknown, not free.

### Other
- Reasoning tier cost: `claude-opus-4.8` is top-of-market; consider downtiering + opt-in escalation once tier policy is measured.
- Legacy OpenRouter `openrouter/auto` is deprecated upstream; keep the stable slug for now, re-evaluate explicitly (not silently) against `openrouter/auto-beta`.

---

## For Next Hands-Off

1. **Immediate:** human adjudication of the 40 holdout cases; unseal the holdout only against adjudicated labels.
2. **Short-term:** calibration study for Jev confidence; decide whether Jev (or a hybrid) becomes the production classifier.
3. **Medium-term:** measure per-tier response quality to validate (or replace) the static tier→model policy; per-request cost instrumentation.
4. **Deployed config note:** `FAST_TIER_PROVIDER=openrouter` is set on Vercel (Production/Preview/Development) but no deployed fast-tier generation has been exercised — verify before relying on it.

---

## Reference Docs

- Vercel AI Gateway: https://vercel.com/docs/ai-gateway · https://vercel.com/ai-gateway/models
- OpenRouter Auto Router (Auto deprecated; Auto Beta): https://openrouter.ai/docs/guides/routing/routers/auto-router
- TypeSafe Jev: https://docs.typesafe.ai/api · SDK: `@typesafe-ai/sdk` v0.6.0 (v1 API)
- AI SDK v5: https://sdk.vercel.ai