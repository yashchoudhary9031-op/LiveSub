# LiveSub Backend

A minimal, high-performance FastAPI backend for the **LiveSub** Chrome extension (Manifest V3) providing real-time speech-to-text transcription, translation, and video-synchronized subtitles on YouTube.

Designed with clean, modular placeholders so that local offline models (e.g. `faster-whisper`, `MarianMT`) or cloud APIs (e.g. Deepgram, OpenAI Whisper, DeepL) can be plugged in without modifying API routes.

---

## Project Structure

```text
backend/
├── main.py             # FastAPI app, CORS, error handling, REST & WebSocket routes
├── pipeline.py         # transcribe(), translate(), and build_cue() pipelines
├── timing.py           # to_video_time() audio-to-video timeline sync helper
├── schemas.py          # Pydantic data models for requests and responses
├── requirements.txt    # Python dependencies
├── .env.example        # Environment variable template (no secrets required)
├── .env                # Local environment configuration (ignored by git)
├── .gitignore          # Git ignore rules
├── test_api.py         # Pytest test suite for timing, routes, and WebSocket
└── README.md           # Documentation, setup guide, and curl examples
```

---

## 1. Setup & Installation

### Prerequisites
- Python 3.10+ (tested on Python 3.11)

### Setup Steps

1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```

2. **(Optional) Create and activate a virtual environment**:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment**:
   ```bash
   cp .env.example .env
   ```
   *(By default, `STT_PROVIDER=stub` and `TRANSLATE_PROVIDER=stub` are enabled so it runs immediately with no API keys.)*

---

## 2. Running the Server

Start the FastAPI development server with hot reload:

```bash
uvicorn main:app --reload --port 8000
```

Once running:
- **Interactive OpenAPI Documentation (Swagger UI)**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc Documentation**: [http://localhost:8000/redoc](http://localhost:8000/redoc)

---

## 3. Testing with Pytest

Run the test suite covering video timing calculations, every REST route, and the streaming WebSocket:

```bash
pytest
```

or with verbose output:

```bash
pytest -v
```

---

## 4. API Endpoints & Curl Examples

### 1. Health Check
- **Endpoint**: `GET /health`
- **Description**: Returns server status and active STT/translation providers.

```bash
curl -X GET http://localhost:8000/health
```

**Response**:
```json
{
  "status": "ok",
  "stt_provider": "stub",
  "translate_provider": "stub"
}
```

---

### 2. Transcribe Audio Chunk
- **Endpoint**: `POST /api/transcribe`
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `audio`: Audio file (binary)
  - `chunk_start`: Video timeline position where the chunk started (seconds)
  - `rate`: Playback rate (e.g. `1.0`, `1.5`, `2.0`, default `1.0`)
  - `target_lang`: Target translation language code (default `en`)
  - `lang_hint`: (Optional) Spoken language hint (e.g. `hi`)

```bash
# Create dummy audio file for testing
echo "fake-audio-content" > test_audio.wav

curl -X POST http://localhost:8000/api/transcribe \
  -F "audio=@test_audio.wav" \
  -F "chunk_start=12.4" \
  -F "rate=1.5" \
  -F "target_lang=en" \
  -F "lang_hint=hi"
```

**Response**:
```json
{
  "start": 12.4,
  "end": 15.4,
  "lang": "hi",
  "text": "[stub transcript]",
  "translation": "[en] [stub transcript]",
  "source": "stt"
}
```

---

### 3. Translate YouTube Captions
- **Endpoint**: `POST /api/translate`
- **Content-Type**: `application/json`
- **Body**: `{"text": "...", "src": "...", "target": "..."}`

```bash
curl -X POST http://localhost:8000/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Namaste dosto", "src": "hi", "target": "en"}'
```

**Response**:
```json
{
  "translation": "[en] Namaste dosto"
}
```

*(If `src` equals `target`, the original text is returned unchanged).*

---

### 4. Real-Time Streaming WebSocket
- **Endpoint**: `ws://localhost:8000/ws`
- **Protocol**:
  1. Client sends a JSON configuration text message:
     ```json
     {
       "chunk_start": 12.4,
       "rate": 1.5,
       "target_lang": "en",
       "lang_hint": "hi"
     }
     ```
  2. Client sends binary message containing raw audio bytes.
  3. Server responds with a synchronized subtitle cue:
     ```json
     {
       "start": 12.4,
       "end": 15.4,
       "lang": "hi",
       "text": "[stub transcript]",
       "translation": "[en] [stub transcript]",
       "source": "stt"
     }
     ```

You can test this via Python, or with tools like `wscat` / `websocat`:
```bash
# Using websocat
websocat ws://localhost:8000/ws
```

---

## 5. Video Timeline Calculation Rule

Because YouTube playback speeds can change (`0.75x`, `1.25x`, `1.5x`, `2.0x`), audio duration does not directly equal video timeline duration:

$$\text{video\_time} = \text{chunk\_start} + (\text{offset\_in\_chunk} \times \text{rate})$$

Implemented in `timing.py` and rounded to 2 decimal places:
- Chunk start = `12.4`s, Rate = `1.5`, Audio duration = `2.0`s
- Subtitle Cue:
  - `start` = $12.4 + 0.0 \times 1.5 = 12.4$
  - `end` = $12.4 + 2.0 \times 1.5 = 15.4$
