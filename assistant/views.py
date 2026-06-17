"""Views for the Voice-Enabled AI Teaching Assistant.

* ``board``           -> the smart-board single-page UI
* ``api_transcribe``  -> audio clip   -> Groq Whisper -> transcript text
* ``api_command``     -> command text -> Groq Llama   -> structured board payload
"""
from __future__ import annotations

import json

import requests
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from . import prompts
from .groq_client import GroqError, TermsRequiredError, chat_json, synthesize, transcribe

# Orpheus voices available on Groq.
TTS_VOICES = ["diana", "autumn", "hannah", "austin", "daniel", "troy"]


@ensure_csrf_cookie
@require_GET
def board(request):
    """Render the smart-board page (sets the CSRF cookie for fetch calls)."""
    return render(request, "assistant/board.html", {
        "llm_model": settings.GROQ_LLM_MODEL,
        "stt_model": settings.GROQ_STT_MODEL,
        "tts_voice": settings.GROQ_TTS_VOICE,
        "tts_voices": TTS_VOICES,
        "key_configured": bool(settings.GROQ_API_KEY),
    })


@require_GET
def api_health(request):
    return JsonResponse({
        "ok": True,
        "key_configured": bool(settings.GROQ_API_KEY),
        "llm_model": settings.GROQ_LLM_MODEL,
        "stt_model": settings.GROQ_STT_MODEL,
    })


@require_POST
def api_transcribe(request):
    """Receive a recorded audio blob and return the Hinglish transcript."""
    audio = request.FILES.get("audio")
    if not audio:
        return JsonResponse({"error": "No audio file received."}, status=400)
    # Keep the original extension so Whisper can sniff the container format.
    filename = audio.name or "speech.webm"
    try:
        text = transcribe(audio.read(), filename=filename)
    except GroqError as exc:
        return JsonResponse({"error": str(exc)}, status=502)
    return JsonResponse({"transcript": text})


_GEN_ENVELOPE = {"feature", "title", "spoken", "command", "display", "action",
                 "option_index", "target", "mode", "timer_op"}
_EMPTY = (None, "", [], {})


def _merge_display(result):
    """qwen nests feature fields inconsistently (top-level vs display). Merge any
    top-level feature fields into display, filling blanks."""
    display = result.get("display")
    if not isinstance(display, dict):
        display = {}
    for k, v in result.items():
        if k in _GEN_ENVELOPE:
            continue
        if display.get(k) in _EMPTY and v not in _EMPTY:
            display[k] = v
    return display


def _has_content(feature, display):
    if feature == "quiz":
        return bool(display.get("questions"))
    if feature == "explain":
        return bool(display.get("slides") or display.get("points"))
    if feature == "dictation":
        return bool(display.get("english") or display.get("hindi"))
    if feature == "activity":
        return bool(display.get("steps"))
    return True


@require_POST
def api_command(request):
    """Turn a transcribed command into a structured board payload via Groq."""
    try:
        body = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON body."}, status=400)

    text = (body.get("text") or "").strip()
    mode = (body.get("mode") or "auto").strip().lower()
    history = body.get("history") if isinstance(body.get("history"), list) else []
    state = body.get("state") if isinstance(body.get("state"), dict) else {"feature": "idle"}
    if not text:
        return JsonResponse({"error": "Empty command."}, status=400)

    user_prompt = prompts.build_user_prompt(text, mode=mode, state=state)
    try:
        result = chat_json(prompts.AGENT_SYSTEM, user_prompt, history=history[-6:])
    except GroqError as exc:
        msg = str(exc)
        # Free-tier rate limit: degrade to a spoken "wait a moment" instead of an
        # error card so the class flow isn't broken.
        if "429" in msg or "rate limit" in msg.lower():
            return JsonResponse({"action": "say", "command": text,
                "spoken": "एक पल रुकिए, थोड़ा load ज़्यादा है — फिर से बोलिए."})
        return JsonResponse({"error": msg}, status=502)

    # Determine the action (default: generate if it produced a feature, else say).
    action = result.get("action")
    if action not in prompts.ACTIONS:
        action = "generate" if result.get("feature") in prompts.FEATURES else "say"
    result["action"] = action

    if action == "generate":
        feature = result.get("feature")
        if feature not in prompts.FEATURES:
            result["action"] = "say"
            result.setdefault("spoken", "Sorry, samajh nahi aaya. Phir se boliye.")
        else:
            display = _merge_display(result)
            # qwen sometimes returns an empty quiz/explain — regenerate once.
            if not _has_content(feature, display):
                try:
                    retry_prompt = user_prompt + (
                        '\n\nIMPORTANT: the previous attempt was empty. Return action '
                        '"generate" with FULL content — e.g. a quiz MUST have a non-empty '
                        '"questions" array; an explanation MUST have non-empty "slides".')
                    r2 = chat_json(prompts.AGENT_SYSTEM, retry_prompt, history=history[-6:])
                    if r2.get("feature") == feature:
                        d2 = _merge_display(r2)
                        if _has_content(feature, d2):
                            result, display = r2, d2
                except GroqError:
                    pass
            result["display"] = display
            result["action"] = "generate"
            if not _has_content(feature, display):
                result["action"] = "say"
                result["spoken"] = result.get("spoken") or "थोड़ी दिक्कत हुई — फिर से boliye."

    result["command"] = text
    return JsonResponse(result)


@require_POST
def api_tts(request):
    """Synthesize a spoken line with Groq Orpheus; return audio bytes.

    On 409 the front-end knows to fall back to the browser's built-in voice.
    """
    try:
        body = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON body."}, status=400)
    text = (body.get("text") or "").strip()
    voice = (body.get("voice") or "").strip() or None
    if not text:
        return JsonResponse({"error": "Empty text."}, status=400)
    if voice and voice not in TTS_VOICES:
        voice = None
    try:
        audio = synthesize(text[:1200], voice=voice, fmt="wav")
    except TermsRequiredError:
        return JsonResponse({
            "error": "Orpheus TTS not enabled. The org admin must accept the model "
                     "terms at console.groq.com.",
            "fallback": True,
        }, status=409)
    except GroqError as exc:
        msg = str(exc)
        # Orpheus free tier is ~3600 tokens/DAY — when exhausted, signal the
        # client to use the browser voice instead of going silent.
        if "429" in msg or "rate limit" in msg.lower():
            return JsonResponse({"error": msg[:200], "rate_limited": True, "fallback": True}, status=429)
        return JsonResponse({"error": msg, "fallback": True}, status=502)
    resp = HttpResponse(audio, content_type="audio/wav")
    resp["Cache-Control"] = "no-store"
    return resp


# Simple in-memory cache for concept images (topic -> result dict).
_IMAGE_CACHE = {}
_WIKI_API = "https://en.wikipedia.org/w/api.php"
_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
_WIKI_UA = "Guru-Mitra/1.0 (classroom teaching assistant)"
_OK_MIME = ("image/png", "image/jpeg", "image/svg+xml", "image/webp")


def _wiki_lead_image(q):
    """The lead image of the best-matching article (clean, but often absent)."""
    params = {
        "action": "query", "format": "json", "prop": "pageimages",
        "piprop": "thumbnail", "pithumbsize": "900",
        "generator": "search", "gsrsearch": q, "gsrlimit": "1", "gsrnamespace": "0",
    }
    r = requests.get(_WIKI_API, params=params, headers={"User-Agent": _WIKI_UA}, timeout=8)
    for p in r.json().get("query", {}).get("pages", {}).values():
        thumb = (p.get("thumbnail") or {}).get("source")
        if thumb:
            return {"url": thumb, "title": p.get("title"), "source": "Wikimedia Commons"}
    return None


def _commons_file(q):
    """Search Commons files directly — finds an image for almost any topic."""
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrnamespace": "6", "gsrsearch": q, "gsrlimit": "8",
        "prop": "imageinfo", "iiprop": "url|mime", "iiurlwidth": "900",
    }
    r = requests.get(_COMMONS_API, params=params, headers={"User-Agent": _WIKI_UA}, timeout=8)
    pages = sorted(r.json().get("query", {}).get("pages", {}).values(),
                   key=lambda x: x.get("index", 99))
    for p in pages:
        ii = (p.get("imageinfo") or [{}])[0]
        if ii.get("mime") in _OK_MIME and ii.get("thumburl"):
            return {"url": ii["thumburl"], "title": p.get("title", "").replace("File:", ""),
                    "source": "Wikimedia Commons"}
    return None


@require_GET
def api_image(request):
    """Find a relevant educational image for a concept via Wikimedia (no key)."""
    q = (request.GET.get("q") or "").strip()
    if not q:
        return JsonResponse({"url": None})
    key = q.lower()[:80]
    if key in _IMAGE_CACHE:
        return JsonResponse(_IMAGE_CACHE[key])
    out = {"url": None}
    try:
        out = _wiki_lead_image(q) or _commons_file(q) or {"url": None}
    except (requests.RequestException, ValueError):
        pass
    _IMAGE_CACHE[key] = out
    return JsonResponse(out)
