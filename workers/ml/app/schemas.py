from typing import Literal

from pydantic import BaseModel, Field


PrivacyClass = Literal["public", "personal", "sensitive", "financial", "vehicle"]
ModelRoute = Literal["local", "hosted-fallback", "blocked"]


class ModelRequest(BaseModel):
    prompt: str
    sessionId: str
    correlationId: str
    retrievedContext: list[str] = Field(default_factory=list)
    privacyClass: PrivacyClass
    route: ModelRoute
    preferredModel: str | None = None


class TokenUsage(BaseModel):
    promptTokens: int | None = None
    completionTokens: int | None = None


class ModelResponse(BaseModel):
    text: str
    model: str
    route: ModelRoute
    usage: TokenUsage | None = None
