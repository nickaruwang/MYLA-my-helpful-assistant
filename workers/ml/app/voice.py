from dataclasses import dataclass
from typing import Literal


VoiceMode = Literal["disabled", "livekit", "classic_pipeline", "gemma_audio"]


@dataclass(frozen=True)
class VoicePipelineStatus:
    mode: VoiceMode
    ready: bool
    notes: list[str]


def get_voice_status() -> VoicePipelineStatus:
    return VoicePipelineStatus(
        mode="disabled",
        ready=False,
        notes=[
            "Voice is intentionally a contract in the skeleton.",
            "Future modes: LiveKit Agents, classic wake/VAD/STT/TTS, or Gemma 4 native audio.",
            "Barge-in should be handled at the realtime audio layer, not bolted onto chat requests.",
        ],
    )
