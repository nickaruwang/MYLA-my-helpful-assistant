from fastapi import FastAPI

from app.model_router import LocalModelRouter
from app.schemas import ModelRequest, ModelResponse
from app.voice import get_voice_status

app = FastAPI(title="JARVIS ML Worker", version="0.1.0")
router = LocalModelRouter()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"ok": "true", "service": "jarvis-ml-worker", "provider": router.provider}


@app.post("/generate", response_model=ModelResponse)
async def generate(request: ModelRequest) -> ModelResponse:
    return await router.generate(request)


@app.get("/voice/status")
async def voice_status() -> dict[str, object]:
    status = get_voice_status()
    return {"mode": status.mode, "ready": status.ready, "notes": status.notes}
