# 🎙️ Guru-Mitra — Voice-Enabled AI Teaching Assistant

A hands-free AI **co-pilot for live classroom sessions**, built for a teacher in a
Haryana government school. The teacher speaks (in **Hinglish** — a mix of Hindi and
English), and the assistant projects visuals on the **smart board** and talks back.

Powered by **[Groq](https://console.groq.com/docs/overview)**:
- **Whisper** (`whisper-large-v3-turbo`) for speech-to-text that handles Hinglish.
- **Llama** (`llama-3.3-70b-versatile`) for generating the teaching content.
- **Orpheus** (`canopylabs/orpheus-v1-english`) for a natural neural voice that
  reads the whole card aloud (falls back to the browser voice if unavailable).

It listens continuously in **Conversation mode**, remembers context for follow-ups
("aur simple karo", "iska quiz lo"), and shows the dialogue in a side panel.

Built with **Python + Django**. UI: slate-board theme, Lucide icons,
Bricolage Grotesque + Mukta type (Mukta also renders Devanagari).

> **Note:** Orpheus TTS requires a one-time terms acceptance by the Groq org admin
> at `console.groq.com` (already accepted for this deployment). Without it, the app
> automatically uses the browser's built-in voice.

---

## ✅ Features (all four implemented)

| Mode | What the teacher says | What appears on the board |
|------|----------------------|---------------------------|
| 💡 **Live Concept Simplification** | *"Photosynthesis ko aasaan Hinglish me samjhao"* | A **narrated slide deck** — one focused idea per slide, a real educational image (Wikimedia), an everyday analogy, an example, and an animated **flow/cycle diagram**. Auto-plays with the natural voice; navigate with the dots, arrow keys, or "Agla/Pichla". |
| 📝 **Voice-Triggered Quizzing** | *"Water cycle par 4 sawal ka quiz lo"* | MCQs announced aloud + displayed big, with **reveal-answer** and next/previous controls |
| 🌐 **Bilingual Dictation & Translation** | *"Dictation: The sun is the source of energy"* | The content shown in **English and हिन्दी side by side** |
| ⏱️ **Hands-Free Activity Guide** | *"5 minute group activity start karo on shapes"* | Step-by-step instructions + a large **countdown timer** (pause / reset / +1 min) |

> The original brief said *"choose 2"* — all four are built so the teacher can use
> whichever fits the lesson. **Auto** mode lets Groq pick the right one from the command.

---

## 🚀 Quick start

```bash
cd AsstTeacher

# 1. Create the virtualenv and install deps
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Add your Groq API key
cp .env.example .env
#   then edit .env and set GROQ_API_KEY=gsk_...   (get one at https://console.groq.com/keys)

# 3. Run
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

Open **http://localhost:8000** on the smart board's browser (use **Chrome** — best
mic support). To open from another device on the school Wi-Fi, browse to
`http://<this-computer-ip>:8000` and add that origin to `DJANGO_CSRF_TRUSTED_ORIGINS`
in `.env`.

> **Microphone needs a secure context.** `localhost` is treated as secure, so the mic
> works there. Over the LAN by plain IP, browsers block the mic — either use the
> typed-command box, run behind HTTPS, or open it on the smart board directly at
> `localhost`.

---

## 🌐 Live deployment

Hosted on the project server at **https://16.112.66.154.sslip.io**

It runs the same way as the other apps on that box: **gunicorn (unix socket) →
systemd → nginx → Let's Encrypt HTTPS**. No custom domain is used —
[`sslip.io`](https://sslip.io) is free wildcard DNS where `<ip>.sslip.io` always
resolves to `<ip>`, so HTTPS works with zero DNS setup (HTTPS is required for the mic).

Deploy artifacts live in [`deploy/`](deploy/):

| File | Installed to |
|------|--------------|
| `deploy/gunicorn.conf.py` | run via the service (threaded WSGI on `/run/gurumitra/gunicorn.sock`) |
| `deploy/gurumitra.service` | `/etc/systemd/system/gurumitra.service` |
| `deploy/guru.conf` | `/etc/nginx/sites-available/guru.conf` (Certbot added the `:443` block) |

**Operate it:**

```bash
sudo systemctl status gurumitra        # health
sudo systemctl restart gurumitra       # restart after code changes
sudo journalctl -u gurumitra -f        # live logs

# After changing code / static / .env:
source .venv/bin/activate
python manage.py collectstatic --noinput
sudo systemctl restart gurumitra
```

The TLS cert auto-renews via the system `certbot.timer`. To move to a real domain
later: point its DNS A record at the server, then
`sudo certbot --nginx -d your.domain` and add the host to `DJANGO_ALLOWED_HOSTS` /
`DJANGO_CSRF_TRUSTED_ORIGINS` in `.env`.

## 🗣️ How to use it in class

- **Tap to speak** — tap the mic (or hold **Space**), say your command, tap again. Audio goes to Groq Whisper.
- **Conversation** — turn it on for continuous hands-free listening: it auto-detects when you start/stop speaking, replies in a natural voice, and keeps context so follow-ups work ("ab iska quiz lo", "thoda aur simple karo"). The dialogue shows in the side panel.
- **Voice** — toggle spoken replies on/off, and pick the assistant voice (Diana, Austin, Daniel, Troy, Hannah, Autumn). It reads the **whole** card, not just the title.
- **Type a command** — a text box for noisy rooms or quick testing.
- **Mode buttons** — *Auto* lets the AI decide; or force *Explain / Quiz / Dictation / Activity*.

---

## 🏗️ How it works

```
 Teacher's voice
      │  (MediaRecorder / voice-activity detection in the browser)
      ▼
 POST /api/transcribe ──► Groq Whisper ──► Hinglish transcript
      │
      ▼
 POST /api/command ──► Groq Llama (JSON mode) ──► structured board payload
      │                 one call does intent-routing + content generation
      ▼
 Render on the smart board  +  speak the reply (browser TTS)
```

| File | Role |
|------|------|
| `assistant/groq_client.py` | Calls Groq's OpenAI-compatible REST API (Whisper + chat) |
| `assistant/prompts.py` | The system prompt that routes the command to a feature and shapes the JSON |
| `assistant/views.py` | `board` page + `/api/transcribe` + `/api/command` endpoints |
| `assistant/templates/assistant/board.html` | The smart-board single-page UI |
| `assistant/static/assistant/app.js` | Mic capture, VAD, TTS, and rendering for all four features |
| `assistant/static/assistant/styles.css` | Projector-friendly dark, high-contrast, large-font theme |

The model is asked to reply with **one JSON object** (`{feature, title, spoken, display}`)
using Groq's JSON mode, so the front-end can render reliably. The server also
**normalizes** the payload (the model sometimes flattens fields) to guarantee a usable
`display` object.

---

## 🔐 Security notes

- The Groq key lives only in `.env`, which is **git-ignored**. Never commit it.
- **The key that was shared in chat to scaffold this project should be rotated**
  at <https://console.groq.com/keys> — treat any key seen in a chat/log as compromised.
- `DEBUG=True` and `ALLOWED_HOSTS=*` are dev defaults. For anything beyond a classroom
  prototype, set `DJANGO_DEBUG=false`, a real `DJANGO_SECRET_KEY`, a specific
  `DJANGO_ALLOWED_HOSTS`, and serve behind HTTPS with a production server (gunicorn/uvicorn).

---

## ⚙️ Configuration (`.env`)

| Variable | Default | Notes |
|----------|---------|-------|
| `GROQ_API_KEY` | — | **Required.** From the Groq console. |
| `GROQ_LLM_MODEL` | `llama-3.3-70b-versatile` | Any Groq chat model. |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | Use `whisper-large-v3` for max accuracy. |
| `DJANGO_DEBUG` | `true` | Set `false` in production. |
| `DJANGO_ALLOWED_HOSTS` | `*` | Comma-separated. |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | — | e.g. `http://192.168.1.50:8000` for LAN access. |

---

## 📝 Notes & limits (it's a prototype)

- Best in **Google Chrome** (MediaRecorder + Speech Synthesis). The typed-command box
  works in any browser.
- Hands-free uses a simple **volume-based** voice-activity detector; in a very noisy
  room, use *Tap to speak* or the *wake word* for reliability. Thresholds are in
  `app.js` (`startThresh` / `stopThresh`) if you want to tune them.
- Spoken Hinglish quality depends on the OS voices installed; Indian-English / Hindi
  voices sound best. Emoji icons need a system emoji font (standard on Windows/Mac/Android).
- Each command makes live Groq API calls (latency + usage cost apply).
