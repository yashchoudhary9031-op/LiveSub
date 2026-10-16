"""
pipeline.py - Core processing pipeline for LiveSub.

Handles speech-to-text transcription, translation, and cue assembly.
Providers are selected via environment variables (STT_PROVIDER, TRANSLATE_PROVIDER),
allowing easy swapping of local models (e.g. faster-whisper) or cloud APIs
(e.g. Deepgram, OpenAI, DeepL) without altering application routes.
"""

import os
from typing import Optional, Dict, Any

try:
    from timing import to_video_time
except ImportError:
    from .timing import to_video_time


def get_stt_provider() -> str:
    """Retrieve configured STT provider from environment (default: 'stub')."""
    return os.getenv("STT_PROVIDER", "stub").lower()


def get_translate_provider() -> str:
    """Retrieve configured translation provider from environment (default: 'stub')."""
    return os.getenv("TRANSLATE_PROVIDER", "stub").lower()


# ============================================================================
# STT IMPLEMENTATIONS
# ============================================================================

def _transcribe_stub(audio_bytes: bytes, lang_hint: Optional[str] = None) -> Dict[str, Any]:
    """
    Placeholder STT implementation returning mock transcription.
    
    TODO: Replace or extend this with real speech-to-text:
          - faster-whisper (local offline model)
          - Hosted STT API (e.g., Deepgram, OpenAI Whisper, Groq, WhisperX)
    """
    return {
        "text": "[stub transcript]",
        "lang": lang_hint or "hi",
        "duration": 2.0,
    }


def transcribe(audio_bytes: bytes, lang_hint: Optional[str] = None) -> Dict[str, Any]:
    """
    Transcribe raw audio bytes into text, language, and duration.
    Dispatches to the provider designated by STT_PROVIDER.
    """
    provider = get_stt_provider()

    if provider == "stub":
        return _transcribe_stub(audio_bytes, lang_hint=lang_hint)
    else:
        # TODO: Add handlers for "whisper", "deepgram", etc.
        raise NotImplementedError(f"STT provider '{provider}' is not implemented yet.")


# ============================================================================
# TRANSLATION IMPLEMENTATIONS
# ============================================================================

def _translate_stub(text: str, src: str, target: str) -> str:
    """
    Placeholder translation implementation.
    Returns text unchanged if source language equals target language,
    otherwise prepends target tag: f"[{target}] {text}".
    """
    if src == target:
        return text
    return f"[{target}] {text}"


def _translate_google(text: str, src: str, target: str) -> str:
    """
    Real-time translation using Google Translate endpoint via httpx.
    Supports 100+ languages with zero API keys required.
    """
    if not text or not text.strip():
        return text
    if src == target:
        return text

    sl_code = src if src and src.lower() != "auto" else "auto"
    tl_code = target if target else "en"

    try:
        import httpx
        url = "https://translate.googleapis.com/translate_a/single"
        params = {
            "client": "gtx",
            "sl": sl_code,
            "tl": tl_code,
            "dt": "t",
            "q": text,
        }
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                if data and isinstance(data, list) and len(data) > 0 and isinstance(data[0], list):
                    parts = [segment[0] for segment in data[0] if segment and len(segment) > 0 and segment[0]]
                    if parts:
                        return "".join(parts)
    except Exception:
        pass

    # Fallback if network or endpoint fails
    return _translate_stub(text, src, target)


def translate(text: str, src: str, target: str, provider: Optional[str] = None) -> str:
    """
    Translate text from src language to target language.
    Dispatches to provider designated by TRANSLATE_PROVIDER or explicit argument.
    Supports: 'google' (real translation) and 'stub' (placeholder).
    """
    active_provider = (provider or get_translate_provider()).lower()

    if active_provider in ["google", "real"]:
        return _translate_google(text, src, target)
    elif active_provider == "stub":
        return _translate_stub(text, src, target)
    else:
        # Easy extension point for DeepL, etc.
        raise NotImplementedError(f"Translate provider '{active_provider}' is not implemented yet.")


# ============================================================================
# PIPELINE CUE ASSEMBLY
# ============================================================================

def build_cue(
    audio_bytes: bytes,
    chunk_start: float,
    rate: float = 1.0,
    target_lang: str = "en",
    lang_hint: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Process an audio chunk and construct a synchronized subtitle cue.

    1. Transcribe the audio chunk (recovering text, detected language, and chunk duration).
    2. Translate the transcript into target_lang.
    3. Compute video timeline start and end timestamps using to_video_time().
    4. Return cue dictionary conforming to Cue schema.
    """
    stt_res = transcribe(audio_bytes, lang_hint=lang_hint)
    original_text = stt_res.get("text", "")
    detected_lang = stt_res.get("lang", lang_hint or "hi")
    audio_duration = float(stt_res.get("duration", 2.0))

    translated_text = translate(original_text, src=detected_lang, target=target_lang)

    # Convert audio offsets to video timeline seconds
    start_time = to_video_time(chunk_start, 0.0, rate)
    end_time = to_video_time(chunk_start, audio_duration, rate)

    return {
        "start": start_time,
        "end": end_time,
        "lang": detected_lang,
        "text": original_text,
        "translation": translated_text,
        "source": "stt",
    }
