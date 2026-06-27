import os
from pathlib import Path

import httpx

from app.schemas import EmbeddingRequest, EmbeddingResponse, ModelRequest, ModelResponse, TokenUsage


class LocalModelRouter:
    def __init__(self) -> None:
        load_local_env()
        self.provider = os.getenv("LOCAL_MODEL_PROVIDER", "ollama")
        self.ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self.ollama_model = os.getenv("OLLAMA_MODEL", "gemma4:12b")
        self.ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

    async def generate(self, request: ModelRequest) -> ModelResponse:
        if request.route == "blocked":
            return ModelResponse(
                text="This request was blocked by policy before model execution.",
                model="policy-block",
                route="blocked",
            )

        if self.provider == "ollama":
            return await self._generate_with_ollama(request)

        return self._fallback(request, reason=f"Unsupported local model provider: {self.provider}")

    async def embed(self, request: EmbeddingRequest) -> EmbeddingResponse:
        model = request.model or self.ollama_embed_model

        if self.provider != "ollama":
            return EmbeddingResponse(embedding=[], model="unsupported-provider")

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    f"{self.ollama_base_url}/api/embeddings",
                    json={"model": model, "prompt": request.text},
                )
                response.raise_for_status()
        except Exception:  # noqa: BLE001 - callers can fall back to text search.
            return EmbeddingResponse(embedding=[], model=model)

        payload = response.json()
        return EmbeddingResponse(embedding=payload.get("embedding", []), model=model)

    async def _generate_with_ollama(self, request: ModelRequest) -> ModelResponse:
        model = request.preferredModel or self.ollama_model
        prompt = self._format_prompt(request)

        try:
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(
                    f"{self.ollama_base_url}/api/generate",
                    json={
                        "model": model,
                        "prompt": prompt,
                        "stream": False,
                    },
                )
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 - fallback keeps local dev usable.
            return self._fallback(request, reason=f"Ollama unavailable: {exc}")

        payload = response.json()
        return ModelResponse(
            text=payload.get("response", "").strip() or "The local model returned an empty response.",
            model=model,
            route="local",
            usage=TokenUsage(
                promptTokens=payload.get("prompt_eval_count"),
                completionTokens=payload.get("eval_count"),
            ),
        )

    def _format_prompt(self, request: ModelRequest) -> str:
        context = "\n".join(request.retrievedContext[-12:])
        return (
            "You are MYLA, a local-first personal AI second brain. "
            "Use a direct, plainspoken personality. Report exactly what happened, what is pending, "
            "and what the user needs to do next. Never claim an external action succeeded unless "
            "tool context says it did.\n\n"
            f"Privacy class: {request.privacyClass}\n"
            f"Recent context:\n{context or '(none)'}\n\n"
            f"User request:\n{request.prompt}"
        )

    def _fallback(self, request: ModelRequest, reason: str) -> ModelResponse:
        return ModelResponse(
            text=(
                "ML worker fallback response. "
                f"{reason}. "
                "The TypeScript control plane, policy routing, and audit flow are still active."
            ),
            model="ml-worker-fallback",
            route="local",
            usage=TokenUsage(promptTokens=len(request.prompt), completionTokens=0),
        )


def load_local_env() -> None:
    current = Path.cwd()
    for _ in range(5):
        candidate = current / ".env"
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
            return

        if current.parent == current:
            return
        current = current.parent
