"""Thin wrapper around the Groq API used by the teaching assistant.

Groq exposes an OpenAI-compatible REST API. We talk to three endpoints:

* ``/audio/transcriptions`` (Whisper)  -> speech-to-text (Hinglish)
* ``/chat/completions``     (LLM)      -> the conversational agent (JSON mode)
* ``/audio/speech``         (Orpheus)  -> text-to-speech

KEY POOL: the free tier has small per-minute / per-day limits. We keep a pool of
API keys (``settings.GROQ_API_KEYS``); when one returns 429 we put it on a short
cooldown (parsed from Groq's "try again in …") and transparently fail over to the
next key. Only when ALL keys are rate-limited do we report a 429 to the caller.

We use ``requests`` directly so the exact API calls are visible.
"""
from __future__ import annotations

import json
import re
import threading
import time

import requests
from django.conf import settings


class GroqError(RuntimeError):
    """Raised when the Groq API cannot be reached or returns an error."""


class TermsRequiredError(GroqError):
    """The TTS model needs a one-time terms acceptance in the Groq console."""


# ---------------------------------------------------------------- key pool
_lock = threading.Lock()
_cooldown = {}   # api_key -> epoch seconds until it's usable again


def _keys() -> list:
    ks = getattr(settings, "GROQ_API_KEYS", None)
    if not ks:
        ks = [settings.GROQ_API_KEY] if getattr(settings, "GROQ_API_KEY", "") else []
    return [k for k in ks if k]


def _retry_after(text: str, default: int = 30) -> int:
    """Parse Groq's 'try again in 17.02s' / '46m0s' / '1m30s' into seconds."""
    m = re.search(r"try again in\s+([0-9hms.]+)", text or "")
    if not m:
        return default
    total = 0.0
    for num, unit in re.findall(r"([0-9.]+)\s*([hms])", m.group(1)):
        total += float(num) * {"h": 3600, "m": 60, "s": 1}[unit]
    return round(total) or default


def _ordered_keys() -> list:
    """Keys that aren't cooling down (fall back to the soonest-available one)."""
    keys = _keys()
    if not keys:
        raise GroqError(
            "No GROQ_API_KEY/GROQ_API_KEYS set. Add at least one key from "
            "https://console.groq.com/keys to .env"
        )
    now = time.time()
    with _lock:
        ready = [k for k in keys if _cooldown.get(k, 0) <= now]
    return ready or sorted(keys, key=lambda k: _cooldown.get(k, 0))


def _cool(key: str, secs: int) -> None:
    with _lock:
        _cooldown[key] = time.time() + max(1, secs)


def _auth(key: str, extra: dict | None = None) -> dict:
    h = {"Authorization": f"Bearer {key}"}
    if extra:
        h.update(extra)
    return h


# ---------------------------------------------------------------- STT
def transcribe(audio_bytes: bytes, filename: str = "speech.webm",
               language: str | None = None) -> str:
    """Transcribe an audio clip to text with Groq Whisper (auto language)."""
    url = f"{settings.GROQ_BASE_URL}/audio/transcriptions"
    # NOTE: no Whisper `prompt` — it gets echoed back as the transcript on silence.
    last = None
    for key in _ordered_keys():
        files = {"file": (filename, audio_bytes, "application/octet-stream")}
        data = {"model": settings.GROQ_STT_MODEL, "response_format": "json", "temperature": "0"}
        if language:
            data["language"] = language
        try:
            resp = requests.post(url, headers=_auth(key), files=files, data=data, timeout=60)
        except requests.RequestException as exc:
            raise GroqError(f"Could not reach Groq for transcription: {exc}") from exc
        if resp.status_code == 429:
            _cool(key, _retry_after(resp.text)); last = resp; continue   # try the next key
        if resp.status_code != 200:
            raise GroqError(f"Transcription failed ({resp.status_code}): {resp.text[:300]}")
        text = resp.json().get("text", "").strip()
        # Treat punctuation-only / non-word output (typical for silence) as empty.
        return "" if not re.search(r"\w", text, flags=re.UNICODE) else text
    raise GroqError(f"Transcription failed (429): {last.text[:200] if last else 'all keys rate-limited'}")


# ---------------------------------------------------------------- LLM agent
def chat_json(system_prompt: str, user_prompt: str, *, history: list | None = None,
              temperature: float = 0.4, max_tokens: int = 2200) -> dict:
    """Call the chat model in JSON mode and return the parsed object.

    ``history`` is prior ``{"role","content"}`` turns for follow-up context.
    Rotates keys on 429; retries once on a transient invalid-JSON / 5xx.
    """
    url = f"{settings.GROQ_BASE_URL}/chat/completions"
    messages = [{"role": "system", "content": system_prompt}]
    for turn in history or []:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:600]})
    messages.append({"role": "user", "content": user_prompt})
    payload = {
        "model": settings.GROQ_LLM_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    effort = getattr(settings, "GROQ_REASONING_EFFORT", "")
    if effort and "qwen" in settings.GROQ_LLM_MODEL.lower():
        payload["reasoning_effort"] = effort

    last_err = "Generation failed"
    for _attempt in range(2):                       # transient invalid-JSON retry
        resp = None
        for key in _ordered_keys():                 # key failover on 429
            try:
                r = requests.post(url, headers=_auth(key, {"Content-Type": "application/json"}),
                                  json=payload, timeout=60)
            except requests.RequestException as exc:
                raise GroqError(f"Could not reach Groq for generation: {exc}") from exc
            if r.status_code == 429:
                _cool(key, _retry_after(r.text)); resp = r; continue
            resp = r; break
        if resp is None:
            raise GroqError(last_err)
        if resp.status_code == 429:                  # every key is rate-limited
            raise GroqError(f"Generation failed (429): {resp.text[:300]}")
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                last_err = f"Model did not return valid JSON: {content[:200]}"; continue
        last_err = f"Generation failed ({resp.status_code}): {resp.text[:300]}"
        if resp.status_code == 400 and "json_validate_failed" in resp.text:
            continue
        if 500 <= resp.status_code < 600:
            continue
        raise GroqError(last_err)
    raise GroqError(last_err)


# ---------------------------------------------------------------- TTS
def synthesize(text: str, voice: str | None = None, fmt: str = "wav") -> bytes:
    """Synthesize speech with Groq Orpheus. Rotates keys on 429 and skips keys
    that haven't accepted the model terms. Raises TermsRequiredError only if NO
    key can do TTS; GroqError(429) only if ALL keys are rate-limited."""
    url = f"{settings.GROQ_BASE_URL}/audio/speech"
    payload = {
        "model": settings.GROQ_TTS_MODEL,
        "voice": voice or settings.GROQ_TTS_VOICE,
        "input": text,
        "response_format": fmt,
    }
    last_429 = None
    last_terms = None
    for key in _ordered_keys():
        try:
            resp = requests.post(url, headers=_auth(key, {"Content-Type": "application/json"}),
                                 json=payload, timeout=60)
        except requests.RequestException as exc:
            raise GroqError(f"Could not reach Groq for speech: {exc}") from exc
        if resp.status_code == 200:
            return resp.content
        body = resp.text[:400]
        if resp.status_code == 429:
            _cool(key, _retry_after(body)); last_429 = resp; continue
        if resp.status_code == 400 and "terms" in body.lower():
            _cool(key, 6 * 3600); last_terms = body; continue   # this key hasn't accepted Orpheus terms
        raise GroqError(f"Speech failed ({resp.status_code}): {body}")
    if last_429 is not None:
        raise GroqError(f"Speech failed (429): {last_429.text[:200]}")
    if last_terms is not None:
        raise TermsRequiredError(last_terms)
    raise GroqError("Speech failed: no usable Groq key")
