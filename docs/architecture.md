# Architecture

The assistant is split into two runtime boundaries:

- TypeScript control plane: API, state machine, policy, tool routing, OAuth, secrets, approvals, and audit.
- Python ML worker: local model calls, embeddings later, and future voice pipelines.

```mermaid
flowchart TD
  user[User] --> web[Web UI]
  web --> api[TypeScript API]
  api --> policy[Intent And Policy Router]
  api --> sqlite[SQLite State]
  api --> audit[Hash Chained Audit]
  api --> tools[Tool Gateway]
  api --> ml[Python ML Worker]
  ml --> ollama[Ollama Gemma 4]
  tools --> google[Google Read Draft Tools]
  tools --> future[Future Apple Tesla Finance n8n OpenClaw]
```

## Request Flow

1. The API receives a chat request and assigns a correlation ID.
2. The deterministic policy router classifies privacy and risk before model execution.
3. If a tool intent is detected, the tool gateway creates a proposal.
4. Read/low-risk tools can execute and notify. Sensitive/high-risk tools create an approval.
5. The API sends the user request plus safe tool context to the ML worker.
6. The assistant response, tool decision, and model route are persisted and audited.

## Model Routing

All traffic defaults to local Gemma 4 through Ollama. Hosted fallback is reserved for later and should remain disabled for financial, vehicle, Apple Messages, and other sensitive classes unless explicitly approved.

## Memory

The first memory layer is SQLite:

- `messages` stores session history.
- `memory_facts` stores subject-predicate-object facts.
- `memory_relationships` keeps a lightweight graph-compatible shape.

Qdrant and a full graph database can be added later without changing the core contracts.
