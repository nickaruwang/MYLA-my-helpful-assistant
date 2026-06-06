# JARVIS Second Brain

Local-first personal AI assistant skeleton with a TypeScript control plane and Python ML worker.

## What Exists

- TypeScript API for chat, policy routing, tool proposals, approvals, and audit verification.
- Python FastAPI ML worker that calls Gemma 4 through Ollama and falls back safely when Ollama is unavailable.
- SQLite state for sessions, messages, tool proposals, approvals, memory facts, relationships, and audit events.
- Hash-chained append-only audit log with SQLite triggers blocking application-level updates/deletes.
- Minimal React/Vite web UI for chat, notifications, pending approvals, and audit verification.
- Google OAuth scaffolding with safe scopes only: Calendar readonly, Drive metadata readonly, Gmail compose.

## Local Run

1. Copy `.env.example` to `.env` and adjust values.
2. Install JavaScript dependencies:

```bash
corepack enable
pnpm install
```

3. Start the Python worker:

```bash
uv run --project workers/ml uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

4. Start the API and web app:

```bash
pnpm dev
```

5. Open `http://localhost:5173`.

## Gemma 4 Runtime

The worker defaults to Ollama:

```bash
ollama pull gemma4:12b
ollama serve
```

Set `OLLAMA_MODEL` in `.env` if your local hardware needs a smaller Gemma 4 variant.

## Google OAuth

Create a Google OAuth client and set:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/google/callback`

Then visit `http://localhost:3000/oauth/google/start`. Tokens are written to `GOOGLE_TOKEN_PATH`.

The skeleton intentionally does not request Gmail send, Drive write/delete, or broad Gmail read scopes.
