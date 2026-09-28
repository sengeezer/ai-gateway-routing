# AI Gateway Routing — Task-Type LLM Classifier

Application-level, **task-type** model routing for the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). Classify each request into a tier, then hand the request to a per-tier model — deterministically and auditably.

| Tier | When | Static policy (default) |
|------|------|-------------------------|
| `fast` | short / simple text | OpenRouter `openrouter/auto` (togglable → gateway) |
| `reasoning` | hard analysis, long prompts | Vercel gateway → `anthropic/claude-opus-4.8` |
| `vision` | image inputs | Vercel gateway → `openai/gpt-4o` |
| `coding` | code in the prompt | Vercel gateway → `anthropic/claude-sonnet-4` |

**The per-tier static model policy above is a starting hypothesis, not a proven "best model per task type".** No measurement of *response quality* per tier has been done; the eval numbers below measure *routing agreement* only.

Non-`fast` tiers get an explicit model ID **plus a fallback chain** (`providerOptions.gateway.models`).

> **Why not just use the gateway's auto-router?** The Vercel AI Gateway is a provider/reliability layer (fallbacks, cost sorting, provider ordering) — it does **not** classify a request and pick a model. Task-type routing is done at the application level.

> **OpenRouter Auto status:** the legacy Auto router (`openrouter/auto`, NotDiamond-based) is **deprecated upstream**; OpenRouter's docs point at Auto Beta (`openrouter/auto-beta`). This project deliberately keeps using the legacy slug and does **not** silently switch to beta. Its selected model and billed cost are dynamic: a static price for the alias is **unknown**, not free.

## Fast-tier provider (built-in, no local server)

Precedence, highest first:

1. per-call: `routedGenerate({ prompt, fastProvider: 'gateway' })`
2. programmatic: `setFastTierProvider('gateway')`
3. environment: `FAST_TIER_PROVIDER=gateway|openrouter|local`
4. built-in default: `openrouter`

The deployed Vercel project has `FAST_TIER_PROVIDER=openrouter` set in Production, Preview, and Development. No live fast-tier generation through that configuration has been tested yet — treat the deployed behavior as unverified.

`local` (OpenAI-compatible server, e.g. Qwen via llama.cpp) remains an **opt-in legacy path only**. There is no local server in the intended setup; prefer hosted providers.

### Tier profiles: `quality` (default) vs `budget`

Set `TIER_PROFILE=budget` to route every gateway tier to cheap/free models hosted on the gateway (`amazon/nova-micro`, `alibaba/qwen3.7-flash`, `alibaba/qwen3-coder-30b-a3b`, free fallbacks). All budget IDs were verified live against the gateway catalog. Price figures quoted in `src/router.ts` / `src/cost-estimator.ts` were captured 2026-09 and **go stale** — re-check before trusting any dollar figure. See [Generation baseline and cost provenance](#generation-baseline-and-cost-provenance).

```bash
TIER_PROFILE=budget FAST_TIER_PROVIDER=gateway npm run demo
```

## Install

```bash
npm install
cp .env.example .env   # then fill in your keys
```

Required env: `AI_GATEWAY_API_KEY` (gateway tiers) and `OPENROUTER_API_KEY` for the OpenRouter fast tier. For the Jev shadow classifier, `TYPESAFE_API_KEY` (direct transport) — or none extra if you run it through the gateway. Never commit real key values.

## Use

```ts
import { routedGenerate } from './src/router';

const r = await routedGenerate({ prompt: 'Write a SQL query for top customers by revenue.' });
console.log(r.tier, r.provider, r.text); // -> coding gateway ...

// Images route to the vision tier automatically:
await routedGenerate({ prompt: 'What is in this image?', images: [bytesOrUrl] });
```

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | vitest unit/contract tests (offline; run for the current count) |
| `npm run eval` | scores the regex classifier against the labeled set |
| `npm run eval:semantic` | embeddings classifier on the tuned 30-case set (needs key) |
| `npm run eval:compare` | head-to-head: embeddings vs regex on that set |
| `npx tsx eval/shadow-compare.ts` | three-way shadow comparison (see below) |
| `npm run check` | typecheck + test + eval (the CI gate) |
| `npm run demo` | dry-run routing table (no API calls) |
| `npm run e2e` | live generation across all tiers (needs keys) |

## Classifier accuracy — measured, not assumed

Three classifiers exist; `routedGenerate` uses embeddings when `AI_GATEWAY_API_KEY` is present and falls back to regex otherwise (`CLASSIFIER=semantic|regex|auto`, `EMBED_MODEL`).

- **Regex:** ~73% overall, ~12–14% adversarial on the labeled set (`eval/dataset.ts`). Free/instant/offline; the CI gate.
- **Embeddings:** 100% (30/30) on the earlier **tuned 30-case set** — the same set the classifier was iterated against. **That set is not a holdout**; treat 30/30 as an in-sample sanity check, not generalization.
- **Vision:** image presence is a hard rule for both.

`npm run eval` prints per-tier precision/recall, a confusion matrix, and every misroute, and fails below `MIN_ACCURACY` (default 0.70).

## Jev pilot (new, provisional)

`src/jev-classifier.ts` adds a third, **off-by-default** classifier: TypeSafe's Jev model (System One) picks `fast | reasoning | coding | abstain` (note: no `vision` choice) with a full probability distribution and confidence. It never routes live traffic and never silently falls back — every error is explicit and counted.

- Transports (`JEV_TRANSPORT`, default `direct`):
  - `direct` → TypeSafe API (`https://api.typesafe.ai`), model pinned to `jev-1.13.0`, key `TYPESAFE_API_KEY`.
  - `gateway` → Vercel AI Gateway TypeSafe-compatible route (`https://ai-gateway.vercel.sh/typesafe`), model `typesafe-ai/jev`, key `AI_GATEWAY_API_KEY`.
- Bounded budgets: 8s per attempt, 1 retry, 15s total deadline.
- Labels: `provisional`, agent-authored — **no human adjudication has happened yet**.

### Pilot dataset & sealed holdout

`eval/pilot-dataset.ts` holds **100 provisional cases** split **60 validation / 40 holdout**. The holdout is sealed: `eval/shadow-compare.ts` refuses `--holdout` (exit 2) unless an adjudicated-labels artifact exists (`eval/holdout-adjudicated.json` with `{ adjudicated: true, labels }`, or `SHADOW_HOLDOUT_ADJUDICATED`). No predictions have been made against the holdout; **no human adjudication has been performed**.

### Live shadow comparison — provisional results

Live Gateway shadow runs (`JEV_TRANSPORT=gateway npx tsx eval/shadow-compare.ts --live --json`) over the **60 validation cases**, against provisional labels (the most recent verified run):

| comparator | routing agreement | failures |
|---|---|---|
| regex | 36/60 (60.0%) | 0 |
| embeddings | 45/60 (75.0%) | 0 |
| Jev | 53/60 (88.3%) | 0 |

Caveats, all enforced by the harness design:

- Labels are **provisional**, so these are agreement scores, not ground truth.
- **No failures**: all three comparators returned a decision on all 60 cases.
- The 53/60 Jev **policy** figure includes 5 deterministic image-rule cases; Jev actually handled 55 text cases and agreed on **48/55**. Model confidence/probabilities are recorded only for those 55. The reported confidence is **not calibrated** — selective/calibration tables are exploratory, not validated probabilities.
- This measures **task-type routing agreement only**. It is **not** a claim about response quality of any routed model.
- The holdout (40 cases) was not touched and remains sealed.

### Running the shadow comparison

```bash
# Offline default: regex only, validation split, no network, no writes
npx tsx eval/shadow-compare.ts

# Live: + embeddings (needs AI_GATEWAY_API_KEY) and Jev
npx tsx eval/shadow-compare.ts --live

# Jev through the Vercel AI Gateway instead of the direct TypeSafe API
JEV_TRANSPORT=gateway npx tsx eval/shadow-compare.ts --live

# Machine-readable
npx tsx eval/shadow-compare.ts --live --json

# Holdout: refused unless an adjudicated-labels artifact exists
npx tsx eval/shadow-compare.ts --holdout
```

Live runs load credentials from `~/.hermes/.env` (or the ambient environment) and never print them; result rows carry no prompt text and nothing is written to disk.

## Generation baseline and cost provenance

`routedGenerate()` now records a metadata-only Phase-0 generation observation: random request ID, policy descriptor, classifier requested/effective/fallback, selected route versus provider-reported served model/provider, gateway fallback attempts, usage, wall-clock latency, and cost provenance. It emits one console line by default; callers can inject a telemetry sink for structured records. Prompts, images, answers, credentials, headers and provider error messages are **not** included in these records. The public classification endpoint does not generate or emit generation telemetry.

`src/cost-estimator.ts` holds a **dated 2026-09 static price table**. Known rates are *estimates*, not billed costs. Missing prices, local-compute overhead and dynamic `openrouter/auto` pricing return `estimatedUSD: null` / `status: 'unknown'`; only a published free-tier rate can yield a known static zero. The `GenerateOutput.cost` field remains a static estimate/unknown. The telemetry record may report an **in-band provider-reported inference cost** (Gateway metadata or OpenRouter usage) separately as `kind: 'actual'`. It is not a complete bill across all extra charges; REST generation-cost lookup is still deferred. If metadata is missing, served identity and billable cost stay unknown—never substitute an SDK-generated ID or price a known fallback as the selected model.

`src/credits.ts` checks both providers' balances and **warns** (never caps or downgrades; quality-first) via `CREDIT_WARN_THRESHOLD_USD` / `CREDIT_CRITICAL_THRESHOLD_USD`.

## HTTP API (Vercel)

`api/classify.ts` is a Vercel Function that returns the routing decision for a prompt. It is **regex-only classification — no model call, no generation** — so classification itself incurs no model fee. GET and POST are accepted; invalid tiers/providers and unvalidated `images` are rejected, and prompts over 10,000 characters receive 413. It still lacks app-owned authentication and rate limiting; Vercel Deployment Protection may gate access, but do **not** assume it is safe to expose. Live generation is intentionally not exposed publicly.

```bash
curl -s https://<your-deployment>/api/classify \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a SQL query for top customers"}'
# -> {"tier":"coding","provider":"gateway","model":"anthropic/claude-sonnet-4"}
```

Body/query: `prompt` (required), `hasImages`, `forceTier`, `fastProvider`.

```bash
vercel login      # one-time, interactive
vercel --prod
```

No deployed behavior (including the fast-tier provider change) has been exercised live in this iteration.

## License

MIT