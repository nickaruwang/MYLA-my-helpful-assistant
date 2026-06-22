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
        mode="classic_pipeline",
        ready=False,
        notes=[
            "The web app supports browser push-to-talk input and speech synthesis playback.",
            "Server-side STT/TTS is not enabled yet.",
            "Future modes: LiveKit Agents, local VAD/STT/TTS, or Gemma native audio.",
        ],
    )
