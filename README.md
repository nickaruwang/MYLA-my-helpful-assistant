# JARVIS Second Brain

Local-first personal AI assistant skeleton with a TypeScript control plane and Python ML worker.

## What Exists

- TypeScript API for chat, policy routing, schema-backed tools, approvals, memory, and audit verification.
- Python FastAPI ML worker that calls Ollama for generation and embeddings.
- MongoDB document state for sessions, messages, tool proposals, approvals, memory facts, relationships, and audit events.
- Optional Qdrant vector memory for semantic recall.
- React/Vite web UI for sessions, chat, voice input, actionable approvals, memory controls, tool status, and audit verification.
- Google, search, Tesla, and Plaid provider modules with conservative approval policies.

## Local Run

1. Copy `.env.example` to `.env` and adjust values.
2. Install JavaScript dependencies:

```bash
corepack enable
pnpm install
```

3. Start MongoDB and Qdrant locally or through Docker:

```bash
docker compose -f infra/docker/docker-compose.yml up mongo qdrant
```

4. Start the Python worker:

```bash
uv run --project workers/ml uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

5. Start the API and web app:

```bash
pnpm dev
```

6. Open `http://localhost:5173`.

## Gemma 4 Runtime

The worker defaults to Ollama:

```bash
ollama pull gemma4:12b
ollama pull nomic-embed-text
ollama serve
```

Set `OLLAMA_MODEL` and `OLLAMA_EMBED_MODEL` in `.env` if your local hardware needs different local models.

## Google OAuth

Create a Google OAuth client and set:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback`

Then visit `http://localhost:3000/oauth/google/start`. Tokens are written to `GOOGLE_TOKEN_PATH`.

The app requests Calendar read/events, Drive metadata read, and Gmail compose. Calendar writes are manual approval tools, Gmail is draft-only, and Drive remains metadata-only.

## Optional Providers

- Search: set `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `SEARXNG_URL`.
- Tesla: complete Tesla Fleet API OAuth, then set `TESLA_ACCESS_TOKEN` and `TESLA_VEHICLE_ID`. Commands stay manual and are disabled unless `TESLA_COMMANDS_ENABLED=true`.
- Finance: use Plaid Link to create a read-only access token, then set `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKEN`, and `PLAID_ENV`.

## Import Prototype SQLite Data

If you have data from the earlier SQLite skeleton and the `sqlite3` CLI is installed:

```bash
pnpm --filter @jarvis/db import:sqlite -- ./data/jarvis.sqlite
```
