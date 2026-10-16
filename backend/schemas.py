"""
schemas.py - Pydantic data schemas for LiveSub API requests and responses.
"""

from typing import Optional, Any
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Response model for GET /health."""
    status: str = Field(..., description="Service status, e.g. 'ok'")
    stt_provider: str = Field(..., description="Active speech-to-text provider name")
    translate_provider: str = Field(..., description="Active translation provider name")


class Cue(BaseModel):
    """Standard subtitle cue returned by STT pipeline and WebSocket."""
    start: float = Field(..., description="Cue start time on video timeline (seconds)")
    end: float = Field(..., description="Cue end time on video timeline (seconds)")
    lang: str = Field(..., description="Detected or specified source language code (e.g. 'hi', 'en')")
    text: str = Field(..., description="Transcribed original text")
    translation: str = Field(..., description="Translated subtitle text")
    source: str = Field(default="stt", description="Subtitle source identifier ('stt')")


class TranslateRequest(BaseModel):
    """Payload for POST /api/translate."""
    text: str = Field(..., description="Source text to translate")
    src: str = Field(..., description="Source language code (e.g. 'auto', 'en', 'hi')")
    target: str = Field(..., description="Target language code (e.g. 'en', 'es')")


class TranslateResponse(BaseModel):
    """Response model for POST /api/translate."""
    translation: str = Field(..., description="Translated text output")


class WSConfig(BaseModel):
    """Configuration payload sent by client over WebSocket before streaming audio."""
    chunk_start: float = Field(..., description="Video timeline timestamp when audio chunk begins (seconds)")
    rate: float = Field(default=1.0, description="Video playback rate multiplier (e.g. 1.0, 1.5, 2.0)")
    target_lang: str = Field(default="en", description="Target language code for subtitle translation")
    lang_hint: Optional[str] = Field(default=None, description="Optional spoken language hint (e.g. 'hi')")


class ErrorResponse(BaseModel):
    """Standardized error response model."""
    error: str = Field(..., description="Error summary or type")
    message: Optional[str] = Field(default=None, description="Detailed explanation of error")
    details: Optional[Any] = Field(default=None, description="Validation or debug details")
