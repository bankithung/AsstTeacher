"""Gunicorn config for Guru-Mitra (Django WSGI app).

Run with: gunicorn -c deploy/gunicorn.conf.py config.wsgi:application
(working directory = project root). The app is plain WSGI (no websockets), but
each request makes blocking calls to the Groq API, so we use threaded workers
to keep the box responsive while a transcription/generation is in flight.
"""
from __future__ import annotations

import multiprocessing

# Bind to a Unix socket that nginx proxies to (group-readable for www-data).
bind = "unix:/run/gurumitra/gunicorn.sock"
umask = 0o007

# Threaded sync workers: good for I/O-bound work (waiting on Groq).
worker_class = "gthread"
workers = max(2, multiprocessing.cpu_count())
threads = 4

# Recycle workers periodically to bound memory growth.
max_requests = 1000
max_requests_jitter = 100

# Groq calls (Whisper + Llama) can take a few seconds; allow headroom.
timeout = 120
graceful_timeout = 30
keepalive = 5

# Trust the X-Forwarded-* headers nginx sets on the loopback socket.
forwarded_allow_ips = "*"

# Logging to stdout/stderr -> captured by the systemd journal.
accesslog = "-"
errorlog = "-"
loglevel = "info"

proc_name = "gurumitra"
