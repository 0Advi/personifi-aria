# AWS Integration Strategy — personifi-aria

> Based on analysis of **PR #111** (foundational AWS layer) and **PR #112** (engagement metrics + CloudWatch), mapped against the existing codebase.

---

## 1 · What to ADOPT from the PRs

### ✅ Centralized Config (`src/aws/aws-config.ts`)

**Keep.** A single `getAwsConfig()` singleton that reads env-vars once is the right pattern. It already supports per-service enablement checks via `isServiceEnabled()`.

**Fix before merging:**
- Use `parseInt(val, 10) || 6379` for `AWS_ELASTICACHE_PORT` instead of bare `Number()` — avoids `NaN` on invalid input.
- Add `.js` extensions to all ESM imports (e.g., `./engagement-types.js` not `.ts`).

### ✅ S3 Session Archiver (`src/archivist/s3-archive.ts` — already merged)

Already live and working. Uses the correct **local lazy-singleton** pattern:
```
let s3Client: S3Client | null = null
function getS3Client() { … }
```
All new AWS integrations should copy this pattern, not the centralized `aws-clients.ts` one.

### ✅ CloudWatch Metrics Skeleton (`src/aws/cloudwatch-metrics.ts`)

Good scaffolding. Can be useful for monitoring Bedrock latency, proactive send rates, and pipeline health.

### ✅ DynamoDB Engagement Store (`src/pulse/dynamodb-store.ts`)

Clean implementation with PostgreSQL fallback. Fine to adopt once the idempotency issues below are fixed.

### ✅ Engagement Metrics Core (`src/pulse/engagement-metrics.ts`)

Weighted preference tracking is valuable for improving the proactive pipeline and reel targeting.

---

## 2 · What to AVOID / Fix Before Merging

### ❌ Centralized `aws-clients.ts` — shared singleton clients

| Problem | Impact |
|---------|--------|
| Single shared DynamoDB / SNS / Bedrock client across all subagents | Violates subagent isolation; config changes to one subagent affect others |
| Race condition in lazy getters | Concurrent first calls can create duplicate client instances |

**Recommendation:** Delete `src/aws/aws-clients.ts`. Each subagent creates its own client locally (exactly like `s3-archive.ts` does). Use `getAwsConfig()` for creds/region only.

### ❌ High-cardinality CloudWatch `UserId` dimension

Putting raw `UserId` into CloudWatch dimensions will create a *unique metric stream per user*. At $0.30/metric/month this gets expensive fast.

**Fix:** Hash or bucket the userId, or log per-user data to CloudWatch Logs and use Logs Insights for queries instead.

### ❌ Non-idempotent `initializeMetrics`

Calling it twice overwrites existing engagement data. Must check for existing record with a DynamoDB `ConditionExpression` or `attribute_not_exists`.

### ❌ `syncEngagementState` race

Can run before `initializeMetrics` completes, silently failing. Add an upsert pattern: create-if-not-exists within `syncEngagementState` itself.

---

## 3 · AWS-Powered Reel Pipeline (Replace Unreliable 3rd-Party APIs)

The current reel delivery chain in `src/media/reelPipeline.ts`:

```
scraped_media DB → Instagram (instagram120 API) → TikTok (tiktok-api23) → YouTube Shorts
        ↓                   ↓                          ↓                       ↓
    PostgreSQL          RapidAPI                    RapidAPI                RapidAPI
```

All three live scrapers use **RapidAPI third-party endpoints** which are unreliable, rate-limited, and can break without notice.

### Proposed: AWS Lambda Scraper Sub-Agent

```
                ┌──────────────┐
                │  EventBridge │  (cron: every 15-30 min)
                │  Schedule    │
                └──────┬───────┘
                       ▼
              ┌────────────────┐
              │  Lambda:       │  Runs headless scraper
              │  reel-scraper  │  (Playwright on Lambda)
              └────────┬───────┘
                       ▼
               ┌───────────────┐
               │  S3 Bucket    │  Store scraped media URLs,
               │  (reel-cache) │  thumbnails, metadata as JSON
               └───────┬───────┘
                       ▼
              ┌────────────────┐
              │  DynamoDB      │  Index: hashtag → media items
              │  (reel-index)  │  TTL: auto-expire stale content
              └────────────────┘
```

**How it integrates (zero code changes to main bot):**

1. Lambda scraper runs on a schedule (EventBridge), scrapes Instagram/TikTok/YouTube.
2. Results stored in S3 + indexed in DynamoDB keyed by hashtag.
3. The existing `queryScrapedMedia()` function in `reelPipeline.ts` already queries the `scraped_media` PostgreSQL table — add a **DynamoDB-first lookup** with Postgres fallback (same pattern as `dynamodb-store.ts`).
4. Only change: one new function `queryReelIndex()` in `reelPipeline.ts` that reads DynamoDB before falling back to fresh RapidAPI scraping.

**Config required (`.env` additions only):**
```env
AWS_REEL_SCRAPER_LAMBDA=reel-scraper         # Lambda function name
AWS_REEL_INDEX_TABLE=personifi-reel-index     # DynamoDB table name
AWS_REEL_CACHE_BUCKET=personifi-reel-cache    # S3 bucket for media
```

**Benefits:**
- Bot never calls RapidAPI at request-time → latency drops from ~3-5s to <200ms
- Lambda handles rate limits, retries, and API key rotation independently
- Content is pre-validated (TTL-expired content auto-cleaned by DynamoDB)
- No changes to the `fetchReels()` or `pickBestReel()` pipeline logic

---

## 4 · AWS-Powered Data Comparison (Swiggy/Zomato, Ola/Uber/Rapido)

The existing comparison tool surface:

| Tool | File | Data Sources |
|------|------|-------------|
| `compare_rides` | `ride-compare.ts` | Rate-card heuristics (no live API) |
| `compare_food_prices` | `food-compare.ts` | Swiggy + Zomato web scrapers |
| `compare_prices_proactive` | `proactive-compare.ts` | All food + grocery scrapers |
| `grocery_compare` | `grocery-compare.ts` | Blinkit + Zepto + Instamart scrapers |

### Proposed: AWS Lambda Price-Fetcher Sub-Agents

```
    ┌──────────────────────────────────────────────────┐
    │              EventBridge Scheduler               │
    │  Triggers every 10-15 min per active city zone   │
    └─────────────┬──────────────┬─────────────────────┘
                  ▼              ▼
    ┌─────────────────┐  ┌─────────────────┐
    │ Lambda:          │  │ Lambda:          │
    │ food-price-agent │  │ ride-price-agent │
    │ (Swiggy/Zomato)  │  │ (Ola/Uber/      │
    │                  │  │  Rapido scraper) │
    └────────┬─────────┘  └────────┬─────────┘
             ▼                     ▼
    ┌──────────────────────────────────────┐
    │  DynamoDB: price-comparison-cache     │
    │  PK: {category}#{city}#{query}       │
    │  SK: {platform}#{timestamp}          │
    │  TTL: 15 min                         │
    └──────────────────────────────────────┘
```

**Integration with existing tools (minimal changes):**

The existing tools (`food-compare.ts`, `ride-compare.ts`, etc.) already have a cache layer (`scrapers/cache.ts`). The change is:

1. **Before scraping live**, check DynamoDB for pre-fetched data.
2. **If fresh data exists** (< 15 min old), return it directly — no scraping needed.
3. **If no data**, fall back to existing scraper logic (unchanged).

This is a **read-only addition** to one function per tool file. Zero changes to tool definitions, parameters, or output formats.

### Ride Comparison Enhancement

Current `ride-compare.ts` uses **static rate cards** (hardcoded Bengaluru Feb 2026 prices). A Lambda can:

1. Scrape actual Ola/Uber/Rapido fare pages periodically.
2. Store current multipliers and surge data in DynamoDB.
3. The existing `getTimeSurgeInfo()` and `getRainSurgeInfo()` functions can optionally read live surge data from DynamoDB before using hardcoded defaults.

**No breaking changes** — hardcoded rate cards remain as fallback.

---

## 5 · AWS Bedrock for AI Subagent Tasks

PR #112 adds Bedrock client setup. Here's where it can augment existing LLM calls:

| Current Module | Current LLM | Bedrock Opportunity |
|---------------|------------|---------------------|
| `src/pulse/signal-extractor.ts` | Groq (rate-limited) | Bedrock Claude as fallback when Groq 429s |
| `src/scout/reflection.ts` | Groq | Same — Bedrock fallback |
| `src/media/contentIntelligence.ts` | Groq | Bedrock for content tagging when batch processing |
| `src/cognitive.ts` | Multi-provider | Add Bedrock to the provider chain |

**Implementation pattern:**
```typescript
// In src/llm/ provider chain — add Bedrock as a fallback
if (groqResponse.status === 429 && isServiceEnabled('bedrock')) {
    return invokeBedrockModel(prompt);
}
```

This is already partially supported by the `src/llm/` provider chain architecture. Bedrock becomes another provider in the cascade, not a replacement.

---

## 6 · SNS for Notifications (Future)

Currently all outbound messages go through `social/outbound-worker.ts` → Telegram API directly.

**Potential:** SNS topic for notification fan-out (Telegram + future email/push/WhatsApp). However, this requires more architectural work and is **not recommended for Phase 1**.

**Park for later** unless multi-channel delivery becomes a priority.

---

## 7 · Implementation Roadmap

### Phase 1 — Safe, config-only additions (1-2 days)

| # | Task | Risk | Impact |
|---|------|------|--------|
| 1 | Fix PR #111/#112 issues (ESM imports, idempotency, port parsing) | None | Unblocks merge |
| 2 | Remove `aws-clients.ts` — use local client pattern everywhere | None | Cleaner architecture |
| 3 | Fix CloudWatch `UserId` dimension → use hashed buckets | None | Avoids cost explosion |
| 4 | Merge cleaned PRs | Low | Adds `aws-config`, `cloudwatch-metrics`, `engagement-metrics` |

### Phase 2 — Reel Pipeline AWS Backend (3-5 days)

| # | Task | Risk | Impact |
|---|------|------|--------|
| 5 | Create `reel-scraper` Lambda (Playwright + S3 + DynamoDB) | Low | Replaces unreliable RapidAPI |
| 6 | Add DynamoDB lookup to `queryScrapedMedia()` | Minimal | One function addition |
| 7 | Wire EventBridge schedule (every 15 min) | None | Pure AWS config |

### Phase 3 — Price Comparison AWS Backend (3-5 days)

| # | Task | Risk | Impact |
|---|------|------|--------|
| 8 | Create `food-price-agent` Lambda | Low | Pre-fetches Swiggy/Zomato data |
| 9 | Create `ride-price-agent` Lambda | Low | Live surge + fare data |
| 10 | Add DynamoDB cache reads to comparison tools | Minimal | One lookup per tool |

### Phase 4 — Bedrock LLM Fallback (1-2 days)

| # | Task | Risk | Impact |
|---|------|------|--------|
| 11 | Add Bedrock to LLM provider cascade | Low | Eliminates Groq 429 failures |
| 12 | Configure `AWS_BEDROCK_MODEL_ID` in `.env` | None | Config-only |

---

## 8 · Summary: What Changes in the Main Codebase

| File | Change Type | Description |
|------|------------|-------------|
| `.env` / `.env.example` | Config | New AWS env-vars (already in PRs) |
| `src/aws/aws-config.ts` | New module | Config singleton (from PR, with fixes) |
| `src/aws/cloudwatch-metrics.ts` | New module | Metrics publishing (from PR, with fixes) |
| `src/pulse/engagement-metrics.ts` | New module | Engagement tracking (from PR, with fixes) |
| `src/media/reelPipeline.ts` | Small addition | DynamoDB lookup before RapidAPI fallback |
| `src/tools/food-compare.ts` | Small addition | DynamoDB cache read before scraping |
| `src/tools/ride-compare.ts` | Small addition | DynamoDB surge data read (optional) |
| `src/tools/grocery-compare.ts` | Small addition | DynamoDB cache read before scraping |

**Everything else lives in AWS (Lambda functions, EventBridge rules, DynamoDB tables, S3 buckets) and is configured outside the app codebase.**

> [!IMPORTANT]
> No existing tool definitions, handler logic, scraper implementations, or output formats change. All AWS additions are **read-from-cache-first** patterns that fall back to the existing code path when AWS is not configured.
