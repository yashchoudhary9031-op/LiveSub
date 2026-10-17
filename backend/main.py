"""
main.py - LiveSub FastAPI Application.

Provides REST and WebSocket endpoints for real-time speech-to-text
transcription, translation, and video-synchronized subtitle cue delivery.
"""

import os
import json
import time
import asyncio
import logging
from functools import partial
from typing import Optional

from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    Form,
    UploadFile,
    Request,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError

# Load environment variables from .env file if present
load_dotenv()

try:
    from schemas import HealthResponse, Cue, TranslateRequest, TranslateResponse, ErrorResponse
    from pipeline import build_cue, translate, get_stt_provider, get_translate_provider
except ImportError:
    from .schemas import HealthResponse, Cue, TranslateRequest, TranslateResponse, ErrorResponse
    from .pipeline import build_cue, translate, get_stt_provider, get_translate_provider

# Configure application logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("livesub.api")

# Initialize FastAPI application
app = FastAPI(
    title="LiveSub Backend",
    description="Real-time subtitle transcription and translation backend for YouTube LiveSub Chrome Extension",
    version="0.1.0",
)

# ----------------------------------------------------------------------------
# CORS Middleware
# Hackathon setting: Allow all origins so Chrome Extension (Manifest V3) can connect freely.
# TODO: In production, restrict allow_origins to specific extension ID (chrome-extension://<id>) or domain.
# ----------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ----------------------------------------------------------------------------
# Request Logging Middleware
# Logs HTTP method, URL path, response status, and duration in milliseconds.
# ----------------------------------------------------------------------------
@app.middleware("http")
async def log_requests_middleware(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = (time.time() - start_time) * 1000.0
        logger.info(
            f"{request.method} {request.url.path} - {response.status_code} ({duration_ms:.2f}ms)"
        )
        return response
    except Exception as exc:
        duration_ms = (time.time() - start_time) * 1000.0
        logger.error(
            f"{request.method} {request.url.path} - ERROR ({duration_ms:.2f}ms): {exc}"
        )
        raise exc


# ----------------------------------------------------------------------------
# Clean JSON Error Handlers (400 for bad input, 500 with message instead of stack trace)
# ----------------------------------------------------------------------------
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """Handle invalid input / schema validation errors with clean 400 response."""
    logger.warning(f"400 Bad Request on {request.url.path}: {exc.errors()}")
    return JSONResponse(
        status_code=400,
        content={
            "error": "Bad Request",
            "message": "Invalid input parameters",
            "details": exc.errors(),
        },
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Handle explicit HTTPExceptions cleanly."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": "HTTP Error",
            "message": str(exc.detail),
        },
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Handle unhandled exceptions with clean 500 JSON error instead of stack traces."""
    logger.error(f"500 Internal Server Error on {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal Server Error",
            "message": str(exc),
        },
    )


# ----------------------------------------------------------------------------
# Route 1: GET /health
# ----------------------------------------------------------------------------
@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Health check endpoint",
)
async def health_check() -> HealthResponse:
    """
    Returns service health and the currently configured STT and translation providers
    read from environment variables (STT_PROVIDER, TRANSLATE_PROVIDER).
    """
    return HealthResponse(
        status="ok",
        stt_provider=get_stt_provider(),
        translate_provider=get_translate_provider(),
    )


# ----------------------------------------------------------------------------
# Route 2: POST /api/transcribe (multipart/form-data)
# ----------------------------------------------------------------------------
@app.post(
    "/api/transcribe",
    response_model=Cue,
    tags=["Transcription"],
    summary="Transcribe and translate an audio chunk",
)
async def transcribe_chunk(
    audio: UploadFile = File(..., description="Raw audio chunk file"),
    chunk_start: float = Form(..., description="Video seconds when chunk began"),
    rate: float = Form(1.0, description="Video playback rate (default: 1.0)"),
    target_lang: str = Form("en", description="Target translation language (default: 'en')"),
    lang_hint: Optional[str] = Form(None, description="Spoken language hint (e.g. 'hi')"),
) -> Cue:
    """
    Accepts an audio chunk from the Chrome extension, transcribes it, translates it,
    maps timestamps to the video timeline, and returns a single subtitle cue.
    """
    if audio is None:
        raise HTTPException(status_code=400, detail="Missing audio file upload")

    audio_bytes = await audio.read()
    cue_dict = build_cue(
        audio_bytes=audio_bytes,
        chunk_start=chunk_start,
        rate=rate,
        target_lang=target_lang,
        lang_hint=lang_hint,
    )
    return Cue(**cue_dict)


# ----------------------------------------------------------------------------
# Route 3: POST /api/translate (application/json)
# ----------------------------------------------------------------------------
@app.post(
    "/api/translate",
    response_model=TranslateResponse,
    tags=["Translation"],
    summary="Translate text (e.g. existing YouTube captions)",
)
async def translate_text(payload: TranslateRequest) -> TranslateResponse:
    """
    Translates provided text from source language to target language.
    Used for translating existing YouTube closed captions.
    """
    translated = translate(text=payload.text, src=payload.src, target=payload.target)
    return TranslateResponse(translation=translated)


# ----------------------------------------------------------------------------
# Route 4: WS /ws (streaming WebSocket)
# ----------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_stream(websocket: WebSocket):
    """
    Real-time streaming WebSocket endpoint.
    Protocol:
      1. Client sends a JSON text message with metadata:
         {"chunk_start": float, "rate": float, "target_lang": str, "lang_hint": Optional[str]}
      2. Client sends a binary message containing raw audio bytes.
      3. Server replies with one cue as JSON per audio message.
    Handles client disconnects cleanly without server crashes.
    """
    await websocket.accept()
    logger.info("WebSocket connection established")

    # Session state retained across stream chunks
    session_config = {
        "chunk_start": 0.0,
        "rate": 1.0,
        "target_lang": "en",
        "lang_hint": None,
    }

    try:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                logger.info("WebSocket disconnect event received")
                break

            # Process JSON text message: update chunk metadata
            if "text" in message and message["text"] is not None:
                try:
                    payload = json.loads(message["text"])
                    if not isinstance(payload, dict):
                        await websocket.send_json({
                            "error": "Bad Request",
                            "message": "Configuration payload must be a JSON object",
                        })
                        continue

                    # Ignore keepalive ping messages from extension
                    if payload.get("ping"):
                        continue

                    if "chunk_start" in payload:
                        session_config["chunk_start"] = float(payload["chunk_start"])
                    if "rate" in payload:
                        session_config["rate"] = float(payload["rate"])
                    if "target_lang" in payload:
                        session_config["target_lang"] = str(payload["target_lang"])
                    if "lang_hint" in payload:
                        session_config["lang_hint"] = payload["lang_hint"]

                except (json.JSONDecodeError, ValueError) as err:
                    await websocket.send_json({
                        "error": "Bad Request",
                        "message": f"Invalid JSON configuration message: {err}",
                    })

            # Process binary message: audio chunk bytes -> subtitle cue
            elif "bytes" in message and message["bytes"] is not None:
                audio_bytes = message["bytes"]
                try:
                    # Run synchronous Groq STT + Google Translate in thread pool
                    # so the async event loop is NEVER blocked — zero WebSocket stall
                    loop = asyncio.get_event_loop()
                    cue = await loop.run_in_executor(
                        None,
                        partial(
                            build_cue,
                            audio_bytes=audio_bytes,
                            chunk_start=session_config["chunk_start"],
                            rate=session_config["rate"],
                            target_lang=session_config["target_lang"],
                            lang_hint=session_config["lang_hint"],
                        ),
                    )
                    # Only send if there's actual content — skip silent/empty chunks
                    if cue.get("translation") or cue.get("text"):
                        await websocket.send_json(cue)
                except Exception as exc:
                    logger.error(f"Error processing audio in WebSocket: {exc}")
                    await websocket.send_json({
                        "error": "Internal Server Error",
                        "message": str(exc),
                    })

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected normally")
    except Exception as exc:
        logger.error(f"Unexpected error in WebSocket session: {exc}")
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
