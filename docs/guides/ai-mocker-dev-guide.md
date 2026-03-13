# 🛠️ AI Mocker — Contributor / Dev Guide

This guide is for developers working on Prism's AI Mocker package (`packages/ai-mocker`). It covers the architecture, local development workflow, common pitfalls, and debugging strategies.

---

## Package Structure

```
packages/ai-mocker/
├── src/
│   ├── agents/
│   │   ├── context-agent.ts      # Retrieves past interactions from memory
│   │   ├── generator-agent.ts    # LLM-powered response generation
│   │   ├── memory-agent.ts       # Persists request/response pairs
│   │   ├── orchestrator.ts       # Coordinates the full pipeline
│   │   └── types.ts              # Shared agent type contracts
│   ├── memory/
│   │   ├── store.ts              # SQLite + sqlite-vec vector store
│   │   ├── embedder.ts           # LangChain embedding wrapper
│   │   └── summarizer.ts         # Request/response summarization
│   ├── providers/
│   │   └── config.ts             # Multi-provider factory (OpenAI, Azure)
│   ├── schema/
│   │   ├── compliance.ts         # Ajv schema validation
│   │   └── json-schema-to-zod.ts # Schema conversion utilities
│   ├── util/
│   │   ├── cache.ts              # LRU response cache
│   │   ├── concurrency.ts        # ResourceMutex + LLM limiter
│   │   ├── timeout.ts            # withTimeout + budget constants
│   │   └── index.ts              # Barrel exports
│   ├── config.ts                 # AiMockerConfig type
│   └── index.ts                  # Entry point: createAiPayloadGenerator
└── __tests__/                    # Jest test suites
```

---

## Local Development

### Prerequisites

- Node.js ≥ 18.20.1
- `yarn` (v1 classic)
- An OpenAI or Azure OpenAI API key for integration testing

### Build

```bash
# From the workspace root:
yarn clean && yarn build
```

> **Critical**: The CLI runs from `packages/cli/dist/`. Any source changes to `ai-mocker` (or any other package) require a full `yarn build` before they take effect in `prism mock --ai`.

### Run Tests

```bash
# Unit tests only (no API key needed)
yarn test --selectProjects ai-mocker

# All tests
yarn test
```

### Live Integration Test

```bash
# Make sure API keys are in your environment
./live-test.sh
```

The script starts Prism on port 4020, runs a series of curl commands against the Petstore spec, and dumps the server log to `live-demo.log`.

---

## Architecture Deep Dive

### Pipeline Flow

```
createAiPayloadGenerator()
  └── returns (schema) => TaskEither
        │
        ├── TE.tryCatch
        │     ├── getOrInitChatModel()     ← lazy, catches sync errors
        │     ├── getOrInitStore()
        │     ├── getOrInitEmbedder()
        │     │
        │     └── orchestrate(operation, request, schema, deps)
        │           ├── classifyIntent()
        │           ├── contextAgent()       ← embed + vector search
        │           ├── responseCache.get()  ← short-circuit if cached
        │           ├── resourceMutex.acquire() ← serialize mutations
        │           ├── generatorAgent()     ← LLM call
        │           │     ├── cleanForLlm(schema)  ← strip xml/example
        │           │     ├── withStructuredOutput()
        │           │     └── validateWithAjv()
        │           ├── responseCache.set()
        │           └── memoryAgent()        ← fire-and-forget persist
        │
        └── on Left → fakerFallback(schema)
```

### Key Design Decisions

**Lazy Singleton Initialization** — Chat model and embedding model constructors (from `@langchain/openai`) perform synchronous API key validation. If they throw, it crashes the Node process. By initializing inside the `TE.tryCatch` thunk, we catch these errors and gracefully fall back to faker.

**Schema Sanitization** — Azure OpenAI's Structured Output mode enforces strict JSON Schema compliance. OpenAPI specs commonly include extensions like `xml`, `example`, and use `additionalProperties` freely. The `cleanForLlm()` function in `generator-agent.ts` recursively strips these before sending to the LLM. Ajv validation still uses the original schema.

**`IOEither` → `TaskEither` Migration** — The original Prism mock pipeline was synchronous (`IOEither`). The AI mocker introduced async LLM calls, requiring an upgrade to `TaskEither` / `ReaderTaskEither` in the core factory. See `packages/core/src/factory.ts` line 65 and `packages/core/src/types.ts` line 53.

---

## Common Pitfalls

### 1. Forgetting to Rebuild

The most common "why isn't my change working" issue. The CLI binary runs from `dist/`, so you **must** run `yarn build` after any source edit.

### 2. Stale Memory Database

The memory store persists across runs. If you've been debugging with broken config, the database will contain faker fallback values. The LLM reads these as "prior interactions" and faithfully reproduces them.

```bash
# Nuclear option — wipe everything
rm -f .prism-memory.db .prism-memory.db-shm .prism-memory.db-wal
```

### 3. Ghost Processes

If Prism crashes mid-test but the background process stays alive, `live-test.sh` will silently talk to the zombie instead of your new build.

```bash
# Find and kill
lsof -t -i:4020 | xargs kill -9
```

### 4. Pino Logger Filtering

Prism's custom Pino logger aggressively filters log output. String-only messages like `logger.info('my message')` may be silently dropped. Always use **object-first** structured logging:

```typescript
// ✅ Works
logger.info({ step: 'init', detail: 'foo' }, 'Initialization complete');

// ❌ May be filtered
logger.info('Initialization complete');
```

### 5. Ajv Strict Mode

Ajv defaults to strict mode, which rejects any unknown JSON Schema keywords. OpenAPI specs are full of non-standard extensions. Set `strict: false` when creating Ajv instances that will compile OpenAPI-derived schemas:

```typescript
const ajv = new Ajv({ allErrors: true, strict: false });
```

---

## Adding a New Provider

1. Add the provider type to `ChatProvider` or `EmbeddingProvider` in `providers/config.ts`
2. Add a new `case` in the `switch` block of `createChatModel()` or `createEmbeddingModel()`
3. Use the corresponding `@langchain/*` package constructor
4. Document the required environment variables in the user guide

---

## Timeout Tuning

Timeouts are defined in `src/util/timeout.ts`:

| Constant | Default | Scope |
|---|---|---|
| `EMBEDDING_TIMEOUT_MS` | 3000 | Single embedding call |
| `LLM_TIMEOUT_MS` | 15000 | Single LLM generation call |
| `PIPELINE_TIMEOUT_MS` | 20000 | Full orchestrator pipeline |

If you're working with slower models or higher-latency networks, increase these values. The pipeline timeout should always exceed the sum of embedding + LLM timeouts to avoid masking the real failure source.

---

## Testing Strategy

- **Unit tests** (`__tests__/`) use mocked LangChain models and an in-memory SQLite store. No API keys needed.
- **Integration tests** (`live-test.sh`) hit the real Azure/OpenAI API. Requires credentials.
- **Ajv compliance tests** (`schema/__tests__/compliance.test.ts`) verify schema validation against known good/bad payloads.

When adding new agent functionality:
1. Write the unit test first (TDD)
2. Mock `BaseChatModel` using `jest.fn()` returning structured output
3. Use `_resetSingletons()` (exported from `index.ts`) between tests to avoid state leakage
