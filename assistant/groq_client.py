"""Thin wrapper around the Groq API used by the teaching assistant.

Groq exposes an OpenAI-compatible REST API. We talk to two endpoints:

* ``/audio/transcriptions`` with a Whisper model  -> speech-to-text (Hinglish)
* ``/chat/completions``      with a Llama model    -> explanations / quizzes / etc.

Docs: https://console.groq.com/docs/overview

We use ``requests`` directly (instead of the SDK) so the exact API calls are
visible and the project has one fewer dependency to pin on Python 3.14.
"""
from __future__ import annotations

import json
import re

import requests
from django.conf import settings


class GroqError(RuntimeError):
    """Raised when the Groq API cannot be reached or returns an error."""


def _headers() -> dict:
    if not settings.GROQ_API_KEY:
        raise GroqError(
            "GROQ_API_KEY is not set. Copy .env.example to .env and add your key "
            "from https://console.groq.com/keys"
        )
    return {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}


def transcribe(audio_bytes: bytes, filename: str = "speech.webm",
               language: str | None = None) -> str:
    """Transcribe an audio clip to text with Groq Whisper.

    ``language`` is left as None so Whisper auto-detects and can handle the
    Hindi/English code-switching (Hinglish) common in the classroom.
    """
    url = f"{settings.GROQ_BASE_URL}/audio/transcriptions"
    files = {"file": (filename, audio_bytes, "application/octet-stream")}
    # NOTE: we deliberately do NOT pass a Whisper `prompt`. Whisper echoes the
    # prompt back as the transcript when the clip has little/no speech, which
    # would be sent on as a bogus command. No prompt = empty result on silence.
    data = {
        "model": settings.GROQ_STT_MODEL,
        "response_format": "json",
        "temperature": "0",
    }
    if language:
        data["language"] = language
    try:
        resp = requests.post(url, headers=_headers(), files=files, data=data, timeout=60)
    except requests.RequestException as exc:  # network problem
        raise GroqError(f"Could not reach Groq for transcription: {exc}") from exc
    if resp.status_code != 200:
        raise GroqError(f"Transcription failed ({resp.status_code}): {resp.text[:300]}")
    text = resp.json().get("text", "").strip()
    # Treat punctuation-only / non-word output (typical for silence) as empty.
    if not re.search(r"\w", text, flags=re.UNICODE):
        return ""
    return text


def chat_json(system_prompt: str, user_prompt: str, *, history: list | None = None,
              temperature: float = 0.4, max_tokens: int = 2200) -> dict:
    """Call the chat model in JSON mode and return the parsed object.

    ``history`` is an optional list of prior ``{"role", "content"}`` turns
    inserted before the current command so follow-ups have context. Groq
    supports OpenAI-style ``response_format={"type": "json_object"}`` which
    forces the model to emit a single valid JSON object.
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
    # Qwen3 reasoning models: disable/limit the <think> step so JSON stays clean.
    effort = getattr(settings, "GROQ_REASONING_EFFORT", "")
    if effort and "qwen" in settings.GROQ_LLM_MODEL.lower():
        payload["reasoning_effort"] = effort
    # qwen occasionally emits invalid/truncated JSON; Groq rejects it with a 400
    # "json_validate_failed". That's usually transient, so retry once before failing.
    last_err = "Generation failed"
    for attempt in range(2):
        try:
            resp = requests.post(
                url,
                headers={**_headers(), "Content-Type": "application/json"},
                json=payload,
                timeout=60,
            )
        except requests.RequestException as exc:
            raise GroqError(f"Could not reach Groq for generation: {exc}") from exc
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                last_err = f"Model did not return valid JSON: {content[:200]}"
                continue                                   # retry
        if resp.status_code == 429:                        # rate limit: no point retrying now
            raise GroqError(f"Generation failed (429): {resp.text[:300]}")
        last_err = f"Generation failed ({resp.status_code}): {resp.text[:300]}"
        if resp.status_code == 400 and "json_validate_failed" in resp.text:
            continue                                       # transient JSON failure: retry
        if 500 <= resp.status_code < 600:
            continue                                       # transient server error: retry
        raise GroqError(last_err)
    raise GroqError(last_err)


class TermsRequiredError(GroqError):
    """The TTS model needs a one-time terms acceptance in the Groq console."""


def synthesize(text: str, voice: str | None = None, fmt: str = "wav") -> bytes:
    """Synthesize speech with Groq's Orpheus TTS. Returns raw audio bytes.

    Raises TermsRequiredError if the org admin has not yet accepted the model's
    terms, so the caller can fall back to the browser voice gracefully.
    """
    url = f"{settings.GROQ_BASE_URL}/audio/speech"
    payload = {
        "model": settings.GROQ_TTS_MODEL,
        "voice": voice or settings.GROQ_TTS_VOICE,
        "input": text,
        "response_format": fmt,
    }
    try:
        resp = requests.post(
            url,
            headers={**_headers(), "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise GroqError(f"Could not reach Groq for speech: {exc}") from exc
    if resp.status_code == 200:
        return resp.content
    # Surface the "accept terms" case distinctly so the UI can fall back quietly.
    body = resp.text[:400]
    if resp.status_code == 400 and "terms" in body.lower():
        raise TermsRequiredError(body)
    raise GroqError(f"Speech failed ({resp.status_code}): {body}")
