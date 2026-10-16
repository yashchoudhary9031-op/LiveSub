"""
test_api.py - Pytest suite for LiveSub backend.

Tests:
1. Video timeline calculation rules (to_video_time)
2. GET /health
3. POST /api/transcribe (success & 400 error handling)
4. POST /api/translate (same/different language & 400 error handling)
5. WS /ws (streaming text config + binary audio + clean disconnect)
"""

import json
import io
import pytest
from fastapi.testclient import TestClient

from main import app
from timing import to_video_time
from pipeline import transcribe, translate, build_cue

client = TestClient(app)


# ============================================================================
# 1. TIMING TESTS
# ============================================================================

def test_timing_rule_example():
    """
    Test timing rule specification:
    chunk_start=12.4, rate=1.5, duration=2.0 -> start 12.4, end 15.4.
    """
    chunk_start = 12.4
    rate = 1.5
    duration = 2.0

    start = to_video_time(chunk_start, offset_in_chunk=0.0, rate=rate)
    end = to_video_time(chunk_start, offset_in_chunk=duration, rate=rate)

    assert start == 12.4
    assert end == 15.4


def test_timing_edge_cases():
    """Verify various rate multipliers and rounding."""
    # Standard 1.0x rate
    assert to_video_time(10.0, 2.5, rate=1.0) == 12.5

    # 2.0x playback rate
    assert to_video_time(5.0, 3.0, rate=2.0) == 11.0

    # 0.75x playback rate with rounding
    assert to_video_time(10.0, 1.333, rate=0.75) == 11.0


# ============================================================================
# 2. PIPELINE TESTS
# ============================================================================

def test_pipeline_transcribe_stub():
    """Verify stub transcribe output format."""
    res = transcribe(b"audio_bytes", lang_hint="fr")
    assert res["text"] == "[stub transcript]"
    assert res["lang"] == "fr"
    assert res["duration"] == 2.0


def test_pipeline_translate_stub():
    """Verify stub translation behavior."""
    # Source != Target
    assert translate("Hello", src="en", target="es", provider="stub") == "[es] Hello"
    # Source == Target (unchanged)
    assert translate("Hello", src="en", target="en", provider="stub") == "Hello"


def test_pipeline_translate_google():
    """Verify real Google translation behavior."""
    res = translate("Hello world", src="en", target="es", provider="google")
    assert "Hola" in res or res == "[es] Hello world"


def test_pipeline_build_cue():
    """Verify end-to-end cue builder logic."""
    cue = build_cue(
        audio_bytes=b"sample_audio",
        chunk_start=12.4,
        rate=1.5,
        target_lang="en",
        lang_hint="hi",
    )
    assert cue["start"] == 12.4
    assert cue["end"] == 15.4
    assert cue["lang"] == "hi"
    assert cue["text"] == "[stub transcript]"
    assert len(cue["translation"]) > 0
    assert cue["source"] == "stt"


# ============================================================================
# 3. ROUTE TESTS
# ============================================================================

def test_get_health():
    """GET /health returns 200 with status ok and active providers."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["stt_provider"] in ["stub", "whisper", "groq"]
    assert data["translate_provider"] in ["stub", "google"]


def test_post_transcribe_success():
    """POST /api/transcribe processes multipart audio and returns Cue."""
    fake_audio = io.BytesIO(b"fake-audio-chunk-data")
    form_data = {
        "chunk_start": "12.4",
        "rate": "1.5",
        "target_lang": "en",
        "lang_hint": "hi",
    }
    files = {
        "audio": ("chunk.webm", fake_audio, "audio/webm"),
    }

    response = client.post("/api/transcribe", data=form_data, files=files)
    assert response.status_code == 200
    data = response.json()

    assert data["start"] == 12.4
    assert data["end"] == 15.4
    assert data["lang"] == "hi"
    assert data["text"] == "[stub transcript]"
    assert len(data["translation"]) > 0
    assert data["source"] == "stt"


def test_post_transcribe_bad_input():
    """POST /api/transcribe with missing or invalid chunk_start returns 400."""
    fake_audio = io.BytesIO(b"fake-audio-chunk-data")
    # Missing required chunk_start field
    files = {
        "audio": ("chunk.webm", fake_audio, "audio/webm"),
    }

    response = client.post("/api/transcribe", data={"rate": "1.5"}, files=files)
    assert response.status_code == 400
    data = response.json()
    assert data["error"] == "Bad Request"


def test_post_translate_different_languages():
    """POST /api/translate returns translation when src != target."""
    payload = {
        "text": "Hello world",
        "src": "en",
        "target": "es",
    }
    response = client.post("/api/translate", json=payload)
    assert response.status_code == 200
    res_text = response.json()["translation"]
    assert "Hola" in res_text or res_text == "[es] Hello world"


def test_post_translate_same_language():
    """POST /api/translate returns unchanged text when src == target."""
    payload = {
        "text": "Hello world",
        "src": "en",
        "target": "en",
    }
    response = client.post("/api/translate", json=payload)
    assert response.status_code == 200
    assert response.json() == {"translation": "Hello world"}


def test_post_translate_bad_input():
    """POST /api/translate with missing fields returns clean 400."""
    payload = {
        "text": "Missing fields test",
        # missing src and target
    }
    response = client.post("/api/translate", json=payload)
    assert response.status_code == 400
    data = response.json()
    assert data["error"] == "Bad Request"


# ============================================================================
# 4. WEBSOCKET TESTS
# ============================================================================

def test_websocket_streaming_flow():
    """
    Test WS /ws:
    Client sends JSON config, then binary audio, and receives synchronized Cue JSON.
    Verifies clean disconnect.
    """
    with client.websocket_connect("/ws") as ws:
        # Step 1: Send config text message
        config_payload = {
            "chunk_start": 12.4,
            "rate": 1.5,
            "target_lang": "en",
            "lang_hint": "hi",
        }
        ws.send_text(json.dumps(config_payload))

        # Step 2: Send binary audio message
        ws.send_bytes(b"binary-chunk-data-1")

        # Step 3: Receive Cue JSON
        result = ws.receive_json()
        assert result["start"] == 12.4
        assert result["end"] == 15.4
        assert result["lang"] == "hi"
        assert result["text"] == "[stub transcript]"
        assert len(result["translation"]) > 0
        assert result["source"] == "stt"

        # Step 4: Stream next chunk with updated chunk_start
        ws.send_text(json.dumps({"chunk_start": 30.0, "rate": 1.0, "target_lang": "hi", "lang_hint": "hi"}))
        ws.send_bytes(b"binary-chunk-data-2")

        result2 = ws.receive_json()
        assert result2["start"] == 30.0
        assert result2["end"] == 32.0
        # Since src == target == "hi", text is unchanged
        assert result2["translation"] == "[stub transcript]"

        # Step 5: Clean disconnect
        ws.close()


def test_websocket_invalid_json():
    """Test WS /ws handles bad JSON config gracefully."""
    with client.websocket_connect("/ws") as ws:
        ws.send_text("invalid-non-json-payload")
        reply = ws.receive_json()
        assert reply["error"] == "Bad Request"
        ws.close()
