/* Guru-Mitra — conversational voice teaching agent (front-end)
 *
 *   mic --> /api/transcribe (Whisper) --> text
 *   text + screen STATE + history --> /api/command (qwen3) --> an ACTION
 *   dispatch(action): answer a quiz / go next / reveal / switch mode / run a
 *                     timer / repeat / just talk / OR generate new content.
 *   speech --> /api/tts (Orpheus, Hindi/Devanagari). Never the browser voice.
 *
 * The agent is context-aware: when something is on the board it controls it
 * instead of regenerating, so the conversation actually flows.
 */
(() => {
  "use strict";
  const cfg = window.GURU;
  const $ = (id) => document.getElementById(id);

  // ---------- DOM ----------
  const stage = $("stage"), statusEl = $("status"), statusText = $("statusText");
  const micBtn = $("micBtn"), micLabel = $("micLabel");
  const convoToggle = $("convoToggle"), voiceToggle = $("voiceToggle"), voiceIcon = $("voiceIcon");
  const voiceSelect = $("voiceSelect"), typeForm = $("typeForm"), textInput = $("textInput");
  const convoLog = $("convoLog"), convoClear = $("convoClear");

  // ---------- state ----------
  let mode = "auto";
  let voiceOn = true;
  let voice = cfg.defaultVoice || "diana";
  let busy = false, recording = false;
  let stream = null, mediaRecorder = null, chunks = [], mimeType = "audio/webm";
  let explainDeck = null;          // slide-deck state for Explain
  let quiz = null, quizAnswered = false;
  let timer = null;
  let currentFeature = null;       // what's on the board now
  const history = [];              // [{role, content}] compact turns

  const csrftoken = (document.cookie.match("(^|;)\\s*csrftoken\\s*=\\s*([^;]+)") || []).pop() || "";
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const icons = () => { try { window.lucide && lucide.createIcons(); } catch (e) {} };
  const setStatus = (s, t) => { statusEl.dataset.state = s; statusText.textContent = t; };

  // Pause talking + autoplay (but KEEP deck/quiz so control actions can use them).
  function pauseCurrent() { stopSpeaking(); if (explainDeck) explainDeck.autoplay = false; }
  // Fully clear current content (for a fresh generation / mode switch).
  function interrupt() { stopSpeaking(); explainDeck = null; }

  // ============================================================ TTS (Orpheus, Hindi)
  let speakGen = 0, curAudio = null, orpheusDownUntil = 0;
  function stopSpeaking() {
    speakGen++;
    if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; }
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
  }
  // Browser-voice fallback — used ONLY when Orpheus is out of its daily quota,
  // so the assistant is never completely silent.
  let _voices = [];
  function loadVoices() { _voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function pickBrowserVoice() {
    if (!_voices.length) loadVoices();
    const FEMALE = /female|swara|kalpana|heera|aditi|samantha|zira|susan|google\s*(हिन्दी|hindi)|neerja|priya|ananya/i;
    const MALE = /male|madhur|hemant|prabhat|ravi|david|mark|rishi|aaron/i;
    const langs = [/hi-?IN|^hi/i, /en-?IN/i, /^en/i];
    for (const lang of langs) {                 // prefer a female voice in the best language
      const f = _voices.find((x) => lang.test(x.lang) && FEMALE.test(x.name));
      if (f) return f;
    }
    for (const lang of langs) {                 // else any non-male voice in that language
      const n = _voices.find((x) => lang.test(x.lang) && !MALE.test(x.name));
      if (n) return n;
    }
    return _voices.find((x) => /^hi/i.test(x.lang)) || _voices.find((x) => /^en/i.test(x.lang)) || _voices[0];
  }
  function speakBrowser(text, gen) {
    return new Promise((res) => {
      if (!window.speechSynthesis) return res();
      if (!_voices.length) loadVoices();
      const v = pickBrowserVoice();
      const u = new SpeechSynthesisUtterance(text);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "hi-IN";
      u.rate = 0.98;
      let fin = false;
      const done = () => { if (fin) return; fin = true; clearTimeout(to); res(); };
      const to = setTimeout(done, Math.min(20000, 2500 + text.length * 80)); // never hang
      u.onend = done; u.onerror = done;
      speechSynthesis.speak(u);
    });
  }
  async function speakLines(lines) {
    stopSpeaking();
    lines = (lines || []).map((x) => (x || "").trim()).filter(Boolean);
    if (!voiceOn || !lines.length) return;
    const gen = ++speakGen;
    setStatus("speaking", "बोल रहा हूँ…");
    for (const ln of lines) { if (gen !== speakGen || !voiceOn) return; await speakOne(ln, gen); }
    if (gen === speakGen && !busy && !(explainDeck && explainDeck.autoplay))
      setStatus(vad.on ? "listening" : "idle", vad.on ? "सुन रहा हूँ…" : "तैयार");
  }
  async function speakOne(text, gen) {
    // Devanagari goes straight to Orpheus (real matras pronounce far better).
    text = (text || "").trim(); if (!text) return;
    // Skip Orpheus while it's known to be out of its daily quota.
    if (Date.now() >= orpheusDownUntil) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (gen !== speakGen || !voiceOn) return;
        try {
          const blob = await fetchTTS(text);
          if (gen !== speakGen || !voiceOn) return;
          await playBlob(blob, gen);
          return;
        } catch (e) {
          if (e && e.rateLimited) {            // daily quota exhausted -> browser voice
            orpheusDownUntil = Date.now() + 5 * 60 * 1000;
            console.warn("Orpheus out of quota — falling back to the browser voice.");
            break;
          }
          if (e && e.terms) break;             // not enabled -> browser voice
        }
      }
    }
    // Fallback: browser voice, only when Orpheus is unavailable/quota-exhausted.
    if (gen !== speakGen || !voiceOn) return;
    await speakBrowser(text, gen);
  }
  async function fetchTTS(text) {
    const r = await fetch(cfg.ttsUrl, {
      method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": csrftoken },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) {
      const err = new Error("tts failed");
      err.terms = r.status === 409; err.rateLimited = r.status === 429;
      throw err;
    }
    return await r.blob();
  }
  function playBlob(blob, gen) {
    return new Promise((res) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url); curAudio = a;
      const done = () => { URL.revokeObjectURL(url); if (curAudio === a) curAudio = null; res(); };
      a.onended = done; a.onerror = done;
      a.onpause = () => { if (gen !== speakGen) done(); };
      a.play().catch(done);
    });
  }

  // ============================================================ Network
  async function transcribe(blob, filename) {
    const fd = new FormData(); fd.append("audio", blob, filename);
    const r = await fetch(cfg.transcribeUrl, { method: "POST", headers: { "X-CSRFToken": csrftoken }, body: fd });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Transcription failed");
    return (d.transcript || "").trim();
  }
  function getState() {
    if (explainDeck) return { feature: "explain", title: explainDeck.title,
      slide: (explainDeck.idx + 1) + " of " + explainDeck.slides.length };
    if (quiz) { const q = quiz.questions[quiz.idx] || {};
      return { feature: "quiz", topic: quiz.topic,
        question_number: (quiz.idx + 1) + " of " + quiz.questions.length,
        current_question: q.question, options: q.options || [], answered: quizAnswered }; }
    if (timer) return { feature: "activity", timer_running: !!timer.running, remaining_seconds: timer.remaining };
    if (currentFeature === "dictation") return { feature: "dictation" };
    return { feature: "idle" };
  }
  async function runCommand(text) {
    const r = await fetch(cfg.commandUrl, {
      method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": csrftoken },
      body: JSON.stringify({ text, mode, history: history.slice(-6), state: getState() }),
    });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Generation failed");
    return d;
  }

  // ============================================================ Mic / recording
  async function getStream() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return stream;
  }
  function pickMime() {
    for (const o of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"])
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(o)) return o;
    return "";
  }
  const extFor = (m) => (m.includes("mp4") ? "m4a" : m.includes("ogg") ? "ogg" : "webm");

  async function startManualRecording() {
    if (busy) return;
    try { await getStream(); }
    catch (e) { return showNotice("err", "alert-triangle", "Microphone access nahi mila", "Browser me microphone permission allow karein, phir try karein."); }
    pauseCurrent();
    mimeType = pickMime(); chunks = [];
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size > 800) handleUtterance(blob); else setStatus("idle", "तैयार");
    };
    mediaRecorder.start();
    recording = true; micBtn.classList.add("live"); micLabel.textContent = "Stop";
    setStatus("recording", "सुन रहा हूँ… (tap to stop)");
  }
  function stopManualRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    recording = false; micBtn.classList.remove("live"); micLabel.textContent = "Tap to speak";
  }

  // ============================================================ Silero neural VAD
  // Lazy-load @ricky0123/vad-web (self-hosted at /vad/) only when Conversation
  // mode is first turned on, so the page stays light otherwise.
  let vadLibPromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
      document.head.appendChild(s);
    });
  }
  async function ensureVadLib() {
    if (window.vad && window.vad.MicVAD) return;
    if (!vadLibPromise) vadLibPromise = (async () => {
      await loadScript("/vad/ort.min.js");
      if (window.ort) window.ort.env.wasm.wasmPaths = "/vad/";
      await loadScript("/vad/bundle.min.js");
    })();
    await vadLibPromise;
    if (!(window.vad && window.vad.MicVAD)) throw new Error("vad lib unavailable");
  }
  // Encode Float32 PCM (Silero gives 16 kHz mono) to a WAV blob for Whisper.
  function floatToWav(float32, sampleRate) {
    const len = float32.length, buf = new ArrayBuffer(44 + len * 2), view = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    w(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, len * 2, true);
    let off = 44; for (let i = 0; i < len; i++) { let s = Math.max(-1, Math.min(1, float32[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
    return new Blob([view], { type: "audio/wav" });
  }

  // ============================================================ Conversation mode (VAD)
  const vad = { on: false, ctx: null, analyser: null, data: null, raf: 0, speaking: false,
    noiseFloor: 0.01, silenceMs: 0, voiceMs: 0, segMs: 0, rec: null, recChunks: [], paused: false,
    last: 0, silero: null, useSilero: false };
  async function startConversation() {
    // Preferred: Silero neural VAD (only real speech reaches Whisper).
    try {
      await ensureVadLib();
      vad.silero = await window.vad.MicVAD.new({
        baseAssetPath: "/vad/", onnxWASMBasePath: "/vad/",
        positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35,
        minSpeechFrames: 3, redemptionFrames: 12, preSpeechPadFrames: 6,
        onSpeechEnd: (audio) => {
          if (vad.paused || busy) return;
          handleUtterance(floatToWav(audio, 16000), "speech.wav");
        },
      });
      vad.useSilero = true; vad.on = true; vad.paused = false;
      vad.silero.start();
      micBtn.disabled = true; micLabel.textContent = "Conversation on";
      setStatus("listening", "सुन रहा हूँ…");
      return;
    } catch (e) {
      console.warn("Silero VAD unavailable, falling back to basic VAD:", e);
      vad.useSilero = false; vad.silero = null;
    }
    // Fallback: simple volume-based VAD.
    try { await getStream(); }
    catch (e) { convoToggle.dataset.on = "false"; return showNotice("err", "alert-triangle", "Microphone access nahi mila", "Allow microphone permission to use conversation mode."); }
    vad.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vad.ctx.createMediaStreamSource(stream);
    vad.analyser = vad.ctx.createAnalyser(); vad.analyser.fftSize = 1024;
    vad.data = new Float32Array(vad.analyser.fftSize); src.connect(vad.analyser);
    vad.on = true; vad.speaking = false; vad.silenceMs = vad.voiceMs = 0; vad.paused = false; vad.last = performance.now();
    micBtn.disabled = true; micLabel.textContent = "Conversation on";
    setStatus("listening", "सुन रहा हूँ…"); vadLoop();
  }
  function stopConversation() {
    vad.on = false;
    if (vad.silero) { try { vad.silero.destroy(); } catch (e) {} vad.silero = null; vad.useSilero = false; }
    cancelAnimationFrame(vad.raf);
    if (vad.rec && vad.rec.state !== "inactive") { try { vad.rec.stop(); } catch (e) {} }
    if (vad.ctx) { try { vad.ctx.close(); } catch (e) {} vad.ctx = null; }
    micBtn.disabled = false; micLabel.textContent = "Tap to speak";
    if (!busy) setStatus("idle", "तैयार");
  }
  function rms() {
    vad.analyser.getFloatTimeDomainData(vad.data);
    let s = 0; for (let i = 0; i < vad.data.length; i++) s += vad.data[i] * vad.data[i];
    return Math.sqrt(s / vad.data.length);
  }
  function vadLoop() {
    if (!vad.on) return;
    vad.raf = requestAnimationFrame(vadLoop);
    const now = performance.now(), dt = now - vad.last; vad.last = now;
    if (vad.paused || busy) return;
    const lvl = rms();
    const startT = Math.max(0.022, vad.noiseFloor * 3), stopT = Math.max(0.014, vad.noiseFloor * 2);
    if (!vad.speaking) {
      vad.noiseFloor = 0.95 * vad.noiseFloor + 0.05 * lvl;
      if (lvl > startT) { vad.voiceMs += dt; if (vad.voiceMs > 120) beginSegment(); } else vad.voiceMs = 0;
    } else {
      if (lvl < stopT) { vad.silenceMs += dt; if (vad.silenceMs > 850) endSegment(); } else vad.silenceMs = 0;
      vad.segMs += dt; if (vad.segMs > 13000) endSegment();
    }
  }
  function beginSegment() {
    vad.speaking = true; vad.silenceMs = 0; vad.segMs = 0;
    mimeType = pickMime(); vad.recChunks = [];
    vad.rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    vad.rec.ondataavailable = (e) => { if (e.data.size) vad.recChunks.push(e.data); };
    vad.rec.onstop = () => {
      const blob = new Blob(vad.recChunks, { type: mimeType || "audio/webm" });
      vad.speaking = false; vad.voiceMs = 0;
      if (blob.size > 1500) handleUtterance(blob);
    };
    vad.rec.start(); setStatus("recording", "सुन रहा हूँ…");
  }
  function endSegment() { if (vad.rec && vad.rec.state !== "inactive") vad.rec.stop(); vad.speaking = false; }
  function resumeListening() {
    if (vad.on) {
      vad.paused = false; vad.speaking = false; vad.silenceMs = vad.voiceMs = 0;
      if (vad.useSilero && vad.silero) { try { vad.silero.start(); } catch (e) {} }
      setStatus("listening", "सुन रहा हूँ…");
    } else setStatus("idle", "तैयार");
  }
  function pauseListening() {  // pause capture while we think / speak
    if (!vad.on) return;
    vad.paused = true;
    if (vad.useSilero && vad.silero) { try { vad.silero.pause(); } catch (e) {} }
  }

  // ============================================================ On-device fast-path
  // Map short, unambiguous control utterances to actions WITHOUT calling the LLM,
  // using the current screen state. Returns an action object or null.
  function optionIndex(t) {
    let m = t.match(/\boption\s*([a-d1-4])\b/) || t.match(/^\s*([a-d1-4])\s*$/);
    if (m) { const c = m[1]; return "1234".includes(c) ? +c - 1 : "abcd".indexOf(c); }
    if (/\b(pehla|pehli|pahla|first)\b/.test(t) || /पहल/.test(t)) return 0;
    if (/\b(dusra|doosra|dusri|second)\b/.test(t) || /दूसर/.test(t)) return 1;
    if (/\b(tisra|teesra|tisri|third)\b/.test(t) || /तीसर/.test(t)) return 2;
    if (/\b(chautha|chauthi|fourth)\b/.test(t) || /चौथ/.test(t)) return 3;
    if (/(^|\s)ए(\s|$)/.test(t)) return 0; if (/(^|\s)बी(\s|$)/.test(t)) return 1;
    if (/(^|\s)सी(\s|$)/.test(t)) return 2; if (/(^|\s)डी(\s|$)/.test(t)) return 3;
    return null;
  }
  function quickIntent(raw) {
    let t = (raw || "").toLowerCase().replace(/[।.!?,|]/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (t.split(" ").length > 4) return null;            // only short utterances
    if (/(samjha|padha|padhao|banao|bana do|explain|dictation|activity|translate|likho|समझा|पढ़ा|बनाओ|डिक्ट|गतिविधि)/.test(t)) return null; // content -> LLM
    const hit = (re) => re.test(t);
    if (hit(/\b(stop|ruko|roko|ruk|bas|chup|shaant)\b/) || /रुक|बस|चुप|ठहर/.test(t)) return { action: "stop", command: raw };
    if (quiz) {
      if (hit(/\b(jawab|jvab|javab|answer|reveal|sahi)\b/) || /जवाब|सही|बताओ|उत्तर/.test(t)) return { action: "reveal", command: raw };
      const oi = optionIndex(t);
      if (oi !== null && oi >= 0) return { action: "answer", option_index: oi, command: raw };
      if (hit(/\b(agla|aage|aagey|next)\b/) || /आगे|अगला/.test(t)) return { action: "navigate", target: "next", command: raw };
      if (hit(/\b(pichla|piche|peeche|previous|prev|back)\b/) || /पिछला|पीछे/.test(t)) return { action: "navigate", target: "prev", command: raw };
    }
    if (explainDeck) {
      if (hit(/\b(dobara|dubara|repeat|firse|phirse)\b/) || /दोबारा|फिर से|फिरसे/.test(t)) return { action: "repeat", command: raw };
      if (hit(/\b(agla|aage|aagey|next)\b/) || /आगे|अगला/.test(t)) return { action: "navigate", target: "next", command: raw };
      if (hit(/\b(pichla|piche|peeche|previous|prev|back)\b/) || /पिछला|पीछे/.test(t)) return { action: "navigate", target: "prev", command: raw };
    }
    if (timer) {
      if (hit(/\b(pause)\b/)) return { action: "timer", timer_op: "pause", command: raw };
      if (hit(/\b(start|resume|shuru|chalu|chalao)\b/) || /शुरू|चालू|चलाओ/.test(t)) return { action: "timer", timer_op: "start", command: raw };
      if (hit(/\b(reset)\b/) || /रीसेट/.test(t)) return { action: "timer", timer_op: "reset", command: raw };
    }
    return null;
  }

  // ============================================================ Pipeline + dispatch
  async function handleUtterance(blob, filename) {
    if (busy) return;
    busy = true; pauseCurrent(); pauseListening();
    setStatus("thinking", "सुन रहा हूँ…");
    try {
      const text = await transcribe(blob, filename || ("speech." + extFor(mimeType)));
      if (!text) { busy = false; resumeListening(); return; }
      await processText(text);
    } catch (e) {
      showNotice("err", "alert-triangle", "Transcription error", e.message);
      busy = false; await speakLines(["माफ़ कीजिए, आवाज़ समझ नहीं आई."]); resumeListening();
    }
  }
  function runTyped(text) {
    if (!text || busy) return;
    busy = true; pauseCurrent(); pauseListening();
    processText(text);
  }
  async function processText(text) {
    addTurn("user", esc(text));
    // Fast-path: handle control commands ON-DEVICE (no LLM call) to avoid the
    // token rate limit. Only fires on short, unambiguous control phrases.
    const quick = quickIntent(text);
    if (quick) { busy = false; await dispatch(quick); resumeListening(); return; }
    setStatus("thinking", "सोच रहा हूँ…");
    try {
      const action = await runCommand(text);
      action.command = action.command || text;
      busy = false;
      await dispatch(action);
    } catch (e) {
      showNotice("err", "alert-triangle", "AI error", e.message);
      busy = false; await speakLines(["माफ़ कीजिए, कुछ गड़बड़ हो गई."]);
    } finally { resumeListening(); }
  }

  async function dispatch(a) {
    const act = a.action || (a.feature ? "generate" : "say");
    if (act === "generate") { await present(a); pushHistory(a); return; }
    let note = a.spoken || "";
    switch (act) {
      case "answer":
        if (quiz && !quizAnswered && Number.isInteger(a.option_index)) { chooseOption(a.option_index); note = ""; }
        else if (quiz && quizAnswered) await speakLines([a.spoken || "इस सवाल का जवाब हो चुका है. अगला सवाल?"]);
        else await speakLines([a.spoken || "अभी कोई सवाल स्क्रीन पर नहीं है."]);
        break;
      case "navigate": await doNavigate(a.target, a.spoken); note = ""; break;
      case "reveal": if (quiz) { revealAnswer(); note = ""; } else await speakLines([a.spoken || "अभी कोई सवाल नहीं है."]); break;
      case "repeat": doRepeat(a.spoken); note = ""; break;
      case "mode": applyMode(a.mode, a.spoken, a.command); break;
      case "timer": doTimer(a.timer_op || a.op, a.spoken); break;
      case "stop": stopSpeaking(); note = "रुक गया"; break;
      case "say": default: await speakLines([a.spoken || "जी, बोलिए."]); break;
    }
    if (note) addTurn("bot", esc(note));
    pushHistory(a);
  }
  function pushHistory(a) {
    history.push({ role: "user", content: a.command || "" });
    const summ = a.action === "generate" ? `[${a.feature}] ${a.title || ""}` : `[${a.action}] ${a.spoken || ""}`;
    history.push({ role: "assistant", content: summ.slice(0, 200) });
  }

  function doNavigate(target) {
    if (explainDeck) {
      let i = explainDeck.idx;
      if (target === "prev") i--; else if (target === "first") i = 0;
      else if (target === "last") i = explainDeck.slides.length - 1; else i++;
      manualGo(i);
    } else if (quiz) {
      let i = quiz.idx;
      if (target === "prev") i--; else if (target === "first") i = 0;
      else if (target === "last") i = quiz.questions.length - 1; else i++;
      quizGo(i);
    } else speakLines(["अभी navigate करने के लिए कुछ नहीं है."]);
  }
  function doRepeat() {
    if (explainDeck) speakLines(slideNarration(explainDeck.slides[explainDeck.idx]));
    else if (quiz) narrateQuestion();
    else speakLines(["दोबारा बताने के लिए कुछ नहीं है."]);
  }
  function applyMode(m, spoken, command) {
    let t = (m || "").toLowerCase();
    if (!/^(auto|explain|quiz|dictation|activity)$/.test(t)) {
      // The model sometimes omits the field — infer the mode from the words.
      const s = ((command || "") + " " + (spoken || "")).toLowerCase();
      t = /quiz|सवाल|प्रश्न/.test(s) ? "quiz"
        : /explain|समझ|concept|कॉन्सेप्ट/.test(s) ? "explain"
        : /dictation|translat|अनुवाद|डिक्ट|लिख/.test(s) ? "dictation"
        : /activity|गतिविधि|एक्टिविटी/.test(s) ? "activity" : "auto";
    }
    setMode(t);
    if (spoken) speakLines([spoken]);
  }
  function doTimer(op, spoken) {
    if (!timer) { speakLines([spoken || "पहले कोई activity शुरू कीजिए."]); return; }
    if (op === "pause") timer.running = false;
    else if (op === "start" || op === "resume") timer.running = true;
    else if (op === "reset") startTimer(timer.total);
    else if (op === "add") { timer.remaining += 60; paintTimer(); }
    syncTimerBtn();
    if (spoken) speakLines([spoken]);
  }

  async function present(payload) {
    interrupt(); quiz = null; quizAnswered = false; clearTimers();
    currentFeature = payload.feature;
    render(payload); icons();
    addBotTurn(payload);
    if (payload.feature === "explain" && explainDeck) await autoplayFrom(0);
    else await speakLines(narration(payload));
  }

  function narration(p) {
    const d = p.display || {}, lines = [p.spoken];
    if (p.feature === "quiz") { const q = (d.questions || [])[0]; if (q) lines.push(quizSpeech(q, 0)); }
    else if (p.feature === "dictation") { if (d.english) lines.push(d.english); if (d.hindi) lines.push(d.hindi); }
    else if (p.feature === "activity") { if (d.goal) lines.push("लक्ष्य. " + d.goal); (d.steps || []).forEach((s, i) => lines.push("Step " + (i + 1) + ". " + s)); }
    return lines;
  }
  function quizSpeech(q, idx) {
    const opts = (q.options || []).map((o, i) => String.fromCharCode(65 + i) + ", " + o).join(". ");
    return "सवाल " + (idx + 1) + ". " + q.question + ". विकल्प. " + opts;
  }

  // ============================================================ Conversation log
  function addTurn(who, html) {
    const empty = convoLog.querySelector(".convo-empty"); if (empty) empty.remove();
    const el = document.createElement("div"); el.className = "turn " + who;
    el.innerHTML = `<span class="who">${who === "user" ? "Teacher" : "Guru-Mitra"}</span>${html}`;
    convoLog.appendChild(el); convoLog.scrollTop = convoLog.scrollHeight; icons();
  }
  function addBotTurn(p) {
    const label = { explain: "समझाया", quiz: "Quiz", dictation: "अनुवाद", activity: "Activity" }[p.feature] || p.feature;
    addTurn("bot", `<span class="feat">${esc(label)}:</span> ${esc(p.title || p.spoken || "")}`);
  }

  // ============================================================ Rendering
  function render(p) {
    if (p.feature === "explain") return renderExplain(p);
    if (p.feature === "quiz") return renderQuiz(p);
    if (p.feature === "dictation") return renderDictation(p);
    if (p.feature === "activity") return renderActivity(p);
    return showNotice("", "help-circle", p.title || "Samajh nahi aaya", p.spoken || "फिर से बोलिए.");
  }
  const FEAT = { explain: "var(--explain)", quiz: "var(--quiz)", dictation: "var(--dictation)", activity: "var(--activity)" };
  function head(feature, icon, tag, title) {
    return `<div class="card-head"><span class="card-tag"><i data-lucide="${icon}"></i>${esc(tag)}</span><h2>${esc(title)}</h2></div>`;
  }

  // ----- explain: narrated slide deck (one flowing idea per slide) -----
  function renderExplain(p) {
    const d = p.display || {};
    const slides = [{ kind: "title", title: p.title || "Concept", subject: d.subject_hint || "", intro: p.spoken || "" }];
    let cs = Array.isArray(d.slides) && d.slides.length ? d.slides : (d.points || []).map((pt) => ({ heading: "", body: pt }));
    cs.forEach((s, i) => slides.push({ kind: "concept", n: i + 1, total: cs.length, heading: s.heading || "", body: s.body || s.text || "" }));
    if (d.analogy) slides.push({ kind: "analogy", body: d.analogy });
    if (d.example) slides.push({ kind: "example", body: d.example });
    if (d.diagram && (d.diagram.nodes || []).length) slides.push({ kind: "diagram", diagram: d.diagram });
    explainDeck = { slides, idx: 0, autoplay: true, title: p.title || "Concept", image: null, imageQuery: d.image_query || p.title || "" };
    showSlide(0); fetchDeckImage();
  }
  function slideBody(s, deck) {
    if (s.kind === "title") {
      const media = deck.image && deck.image.url
        ? `<figure class="slide-media"><img src="${esc(deck.image.url)}" alt="${esc(deck.title)}" loading="lazy" /><figcaption>${esc(deck.image.source || "")}</figcaption></figure>`
        : `<figure class="slide-media ph"><i data-lucide="image"></i></figure>`;
      return `<div class="title-row"><div class="s-title">
          ${s.subject ? `<span class="eyebrow"><i data-lucide="book-open"></i>${esc(s.subject)}</span>` : ""}
          <h2 class="s-big">${esc(s.title)}</h2>
          ${s.intro ? `<p class="s-sub">${esc(s.intro)}</p>` : ""}
        </div>${media}</div>`;
    }
    if (s.kind === "concept") return `${s.heading ? `<span class="s-label">${esc(s.heading)}</span>` : ""}<p class="s-body">${esc(s.body)}</p><span class="s-step">${s.n} / ${s.total}</span>`;
    if (s.kind === "analogy") return `<div class="s-icon"><i data-lucide="sparkles"></i></div><span class="s-label">आसान समझ</span><p class="s-body">${esc(s.body)}</p>`;
    if (s.kind === "example") return `<div class="s-icon"><i data-lucide="pencil"></i></div><span class="s-label">उदाहरण</span><p class="s-body">${esc(s.body)}</p>`;
    if (s.kind === "diagram") return `<span class="s-label">${esc(s.diagram.caption || "Visual")}</span>${diagramHTML(s.diagram)}`;
    return "";
  }
  function showSlide(i) {
    if (!explainDeck) return;
    const deck = explainDeck;
    deck.idx = Math.max(0, Math.min(i, deck.slides.length - 1));
    const s = deck.slides[deck.idx];
    const dots = deck.slides.map((_, k) => `<button class="dot ${k === deck.idx ? "on" : ""}" data-k="${k}" aria-label="Slide ${k + 1}"></button>`).join("");
    stage.innerHTML = `<div class="card deck" style="--feat:${FEAT.explain}">
      <div class="deck-top">
        <span class="card-tag"><i data-lucide="lightbulb"></i>Concept</span>
        <span class="deck-title">${esc(deck.title)}</span>
        <span class="deck-count">${deck.idx + 1} / ${deck.slides.length}</span>
      </div>
      <div class="slide ${s.kind}" data-k="${deck.idx}">${slideBody(s, deck)}</div>
      <div class="deck-nav">
        <button class="btn ghost" id="dPrev" ${deck.idx === 0 ? "disabled" : ""}><i data-lucide="chevron-left"></i>Pichla</button>
        <div class="dots">${dots}</div>
        <button class="btn ghost icon-only" id="dPlay" title="Play / pause"><i data-lucide="${deck.autoplay ? "pause" : "play"}"></i></button>
        <button class="btn primary" id="dNext" ${deck.idx === deck.slides.length - 1 ? "disabled" : ""}>Agla<i data-lucide="chevron-right"></i></button>
      </div></div>`;
    icons();
    $("dPrev").onclick = () => manualGo(deck.idx - 1);
    $("dNext").onclick = () => manualGo(deck.idx + 1);
    $("dPlay").onclick = togglePlay;
    stage.querySelectorAll(".dot").forEach((b) => (b.onclick = () => manualGo(parseInt(b.dataset.k, 10))));
  }
  function slideNarration(s) {
    if (s.kind === "title") return [s.intro || ("चलिए " + s.title + " समझते हैं.")];
    if (s.kind === "analogy") return ["आसान भाषा में. " + s.body];
    if (s.kind === "example") return ["उदाहरण के लिए. " + s.body];
    if (s.kind === "diagram") return [(s.diagram.caption ? s.diagram.caption + ". " : "") + (s.diagram.nodes || []).join(", ")];
    return [s.body || ""];
  }
  function manualGo(i) {
    if (!explainDeck || i < 0 || i >= explainDeck.slides.length) return;
    explainDeck.autoplay = false;
    showSlide(i);
    speakLines(slideNarration(explainDeck.slides[i]));
  }
  function togglePlay() {
    if (!explainDeck) return;
    explainDeck.autoplay = !explainDeck.autoplay;
    showSlide(explainDeck.idx);
    if (explainDeck.autoplay) autoplayFrom(explainDeck.idx); else stopSpeaking();
  }
  async function autoplayFrom(start) {
    const deck = explainDeck;
    for (let k = start; k < deck.slides.length; k++) {
      if (explainDeck !== deck || !deck.autoplay) return;
      showSlide(k);
      await speakLines(slideNarration(deck.slides[k]));
      if (explainDeck !== deck || !deck.autoplay) return;
      await new Promise((r) => setTimeout(r, 450));
    }
    if (explainDeck === deck) { deck.autoplay = false; showSlide(deck.idx); }
  }
  async function fetchDeckImage() {
    const deck = explainDeck;
    if (!deck || !deck.imageQuery) return;
    try {
      const r = await fetch(cfg.imageUrl + "?q=" + encodeURIComponent(deck.imageQuery));
      const d = await r.json();
      if (d && d.url && explainDeck === deck) { deck.image = d; if (deck.slides[deck.idx].kind === "title") showSlide(deck.idx); }
    } catch (e) {}
  }
  function diagramHTML(dia) {
    const nodes = dia.nodes || [];
    if (dia.type === "cycle" && nodes.length >= 3) {
      const n = nodes.length;
      const pts = nodes.map((label, i) => {
        const ang = (-90 + i * 360 / n) * Math.PI / 180;
        const x = 50 + 39 * Math.cos(ang), y = 50 + 39 * Math.sin(ang);
        return `<span class="cnode" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;animation-delay:${(i * 0.12).toFixed(2)}s">${esc(label)}</span>`;
      }).join("");
      return `<div class="cycle"><div class="cycle-ring"><i data-lucide="refresh-cw"></i></div>${pts}</div>`;
    }
    const sep = `<span class="arrow"><i data-lucide="arrow-right"></i></span>`;
    return `<div class="flow">${nodes.map((label, i) => `<span class="node" style="animation-delay:${(i * 0.1).toFixed(2)}s">${esc(label)}</span>`).join(sep)}</div>`;
  }

  // ----- quiz -----
  function renderQuiz(p) {
    const d = p.display || {};
    quiz = { questions: d.questions || [], idx: 0, topic: d.topic || p.title || "Quiz" };
    quizAnswered = false; drawQuiz();
  }
  function drawQuiz() {
    if (!quiz || !quiz.questions.length) return showNotice("err", "help-circle", "No questions", "फिर से quiz माँगिए.");
    quizAnswered = false;
    const q = quiz.questions[quiz.idx];
    const opts = (q.options || []).map((o, i) =>
      `<button class="option" data-i="${i}"><span class="key">${String.fromCharCode(65 + i)}</span><span class="otext">${esc(o)}</span><span class="mk"><i data-lucide="check"></i></span></button>`).join("");
    stage.innerHTML = `<div class="card" style="--feat:${FEAT.quiz}">
      ${head("quiz", "list-checks", "Quiz", quiz.topic)}
      <div class="quiz-meta"><i data-lucide="circle-help"></i>सवाल ${quiz.idx + 1} / ${quiz.questions.length}</div>
      <div class="question">${esc(q.question)}</div>
      <div class="options">${opts}</div>
      <div class="quiz-explain" id="qExplain" style="display:none"></div>
      <div class="row-btns">
        <button class="btn ghost" id="qReveal"><i data-lucide="eye"></i>जवाब दिखाओ</button>
        <button class="btn ghost" id="qPrev" ${quiz.idx === 0 ? "disabled" : ""}><i data-lucide="chevron-left"></i>Pichla</button>
        <button class="btn primary" id="qNext">${quiz.idx === quiz.questions.length - 1 ? "Finish" : "Agla"}<i data-lucide="chevron-right"></i></button>
      </div></div>`;
    icons();
    stage.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => chooseOption(parseInt(b.dataset.i, 10))));
    $("qReveal").addEventListener("click", () => revealAnswer());
    $("qPrev").addEventListener("click", () => quizGo(quiz.idx - 1));
    $("qNext").addEventListener("click", () => {
      if (quiz.idx < quiz.questions.length - 1) quizGo(quiz.idx + 1);
      else speakLines(["शाबाश! Quiz पूरा हो गया."]);
    });
  }
  function quizGo(i) { if (!quiz) return; i = Math.max(0, Math.min(i, quiz.questions.length - 1)); quiz.idx = i; drawQuiz(); narrateQuestion(); }
  function narrateQuestion() { const q = quiz.questions[quiz.idx]; if (q) speakLines([quizSpeech(q, quiz.idx)]); }
  function chooseOption(i) {
    if (!quiz) return;
    const q = quiz.questions[quiz.idx], btns = stage.querySelectorAll(".option");
    quizAnswered = true;
    btns.forEach((b) => (b.style.pointerEvents = "none"));
    if (btns[q.answer_index]) btns[q.answer_index].classList.add("correct");
    if (i !== q.answer_index && btns[i]) btns[i].classList.add("wrong");
    showExplain(q, i === q.answer_index);
  }
  function revealAnswer() {
    if (!quiz) return;
    const q = quiz.questions[quiz.idx], btns = stage.querySelectorAll(".option");
    quizAnswered = true;
    btns.forEach((b) => (b.style.pointerEvents = "none"));
    if (btns[q.answer_index]) btns[q.answer_index].classList.add("correct");
    showExplain(q, null);
  }
  function showExplain(q, correct) {
    const box = $("qExplain"), letter = String.fromCharCode(65 + (q.answer_index || 0));
    const pre = correct === true ? "सही! " : correct === false ? "ग़लत. " : "";
    box.style.display = "block";
    box.innerHTML = `<b>${esc(pre)}सही जवाब: ${letter}.</b> ${esc(q.explanation || "")}`;
    const say = correct === true ? "बिल्कुल सही! " : correct === false ? "ग़लत. सही जवाब है option " + letter + ". " : "सही जवाब है option " + letter + ". ";
    speakLines([say + (q.explanation || "")]);
  }

  function renderDictation(p) {
    const d = p.display || {};
    stage.innerHTML = `<div class="card" style="--feat:${FEAT.dictation}">
      ${head("dictation", "languages", "Dictation", p.title || "Dictation & Translation")}
      <div class="dict-grid">
        <div class="panel"><div class="panel-title"><i data-lucide="type"></i>English</div><div class="dict-text">${esc(d.english || "")}</div></div>
        <div class="panel"><div class="panel-title"><i data-lucide="languages"></i>हिन्दी</div><div class="dict-text">${esc(d.hindi || "")}</div></div>
      </div>
      ${d.notes ? `<div class="notes"><i data-lucide="info"></i><span>${esc(d.notes)}</span></div>` : ""}</div>`;
  }

  function renderActivity(p) {
    const d = p.display || {}, total = parseInt(d.duration_seconds, 10) || 300;
    const steps = (d.steps || []).map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s)}</span></li>`).join("");
    const mats = (d.materials || []).map((m) => `<span class="pill">${esc(m)}</span>`).join("");
    stage.innerHTML = `<div class="card" style="--feat:${FEAT.activity}">
      ${head("activity", "timer", "Activity", p.title || "Class Activity")}
      <div class="act-grid">
        <div class="panel">
          ${d.goal ? `<div class="panel-title"><i data-lucide="target"></i>लक्ष्य</div><div class="analogy" style="margin-bottom:1rem">${esc(d.goal)}</div>` : ""}
          <div class="panel-title"><i data-lucide="list-ordered"></i>Steps</div>
          <ul class="steps">${steps}</ul>
          ${mats ? `<div class="materials"><span class="lbl">Materials:</span>${mats}</div>` : ""}
        </div>
        <div class="timer-box">
          <div class="panel-title" style="justify-content:center"><i data-lucide="alarm-clock"></i>Timer</div>
          <div class="timer" id="timer">${fmt(total)}</div>
          <div class="timer-controls">
            <button class="btn primary" id="tToggle"><i data-lucide="pause"></i>Pause</button>
            <button class="btn ghost" id="tReset"><i data-lucide="rotate-ccw"></i>Reset</button>
            <button class="btn ghost" id="tPlus"><i data-lucide="plus"></i>1 min</button>
          </div>
        </div>
      </div></div>`;
    icons();
    startTimer(total);
    $("tToggle").addEventListener("click", () => { timer.running = !timer.running; syncTimerBtn(); });
    $("tReset").addEventListener("click", () => startTimer(total));
    $("tPlus").addEventListener("click", () => { if (timer) { timer.remaining += 60; paintTimer(); } });
  }
  const fmt = (s) => { s = Math.max(0, s | 0); const m = (s / 60) | 0, ss = s % 60; return `${m}:${ss < 10 ? "0" : ""}${ss}`; };
  function paintTimer() { const el = $("timer"); if (!el || !timer) return; el.textContent = fmt(timer.remaining); el.classList.toggle("low", timer.remaining <= 10); }
  function syncTimerBtn() { const b = $("tToggle"); if (b && timer) { b.innerHTML = timer.running ? '<i data-lucide="pause"></i>Pause' : '<i data-lucide="play"></i>Resume'; icons(); } }
  function startTimer(total) {
    clearTimers(); timer = { remaining: total, running: true, total };
    paintTimer(); syncTimerBtn();
    timer.handle = setInterval(() => {
      if (!timer.running) return;
      timer.remaining--; paintTimer();
      if (timer.remaining <= 0) { clearInterval(timer.handle); timer.running = false; beep(); speakLines(["समय पूरा हो गया!"]); }
    }, 1000);
  }
  function clearTimers() { if (timer && timer.handle) clearInterval(timer.handle); timer = null; }
  function beep() {
    try { const ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.25, ac.currentTime); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.8); o.stop(ac.currentTime + 0.85); } catch (e) {}
  }

  function showNotice(kind, icon, title, body) {
    if (kind === "err") setStatus("error", "Error");
    stage.innerHTML = `<div class="notice ${kind === "err" ? "err" : ""}"><h2><i data-lucide="${icon}"></i>${esc(title)}</h2><p>${esc(body)}</p></div>`;
    icons();
  }

  function renderHero() {
    const keyOk = document.body.dataset.keyConfigured === "1";
    const warn = keyOk ? "" : `<div class="banner"><i data-lucide="alert-triangle"></i><div><b>GROQ_API_KEY missing.</b> Add it to <code>.env</code> and restart.</div></div>`;
    stage.innerHTML = `<div class="hero">${warn}
      <span class="eyebrow"><i data-lucide="mic"></i>आवाज़ से पढ़ाइए · Hindi</span>
      <h1>बोलिए, और board पर <em>सब हो जाएगा.</em></h1>
      <p class="lede">मैं आपका hands-free classroom co-pilot हूँ. Concept समझाना हो, quiz लेना हो, dictation translate करनी हो, या activity चलानी हो — बस tap करके बोलिए, या "Conversation" on कर दीजिए. बीच में "अगला", "option B", "दोबारा बताओ" भी बोल सकते हैं.</p>
      <div class="examples">
        <button class="ex" style="--feat:${FEAT.explain}" data-cmd="Photosynthesis आसान भाषा में समझाओ" data-mode="explain"><span class="ex-h"><i data-lucide="lightbulb"></i>Concept समझाओ</span><span class="ex-say">Photosynthesis आसान भाषा में समझाओ</span></button>
        <button class="ex" style="--feat:${FEAT.quiz}" data-cmd="Water cycle पर चार सवाल का quiz लो" data-mode="quiz"><span class="ex-h"><i data-lucide="list-checks"></i>Voice quiz</span><span class="ex-say">Water cycle पर चार सवाल का quiz लो</span></button>
        <button class="ex" style="--feat:${FEAT.dictation}" data-cmd="Dictation: The sun is the source of energy." data-mode="dictation"><span class="ex-h"><i data-lucide="languages"></i>Dictation & translate</span><span class="ex-say">The sun is the source of energy</span></button>
        <button class="ex" style="--feat:${FEAT.activity}" data-cmd="Shapes पर पाँच मिनट की group activity शुरू करो" data-mode="activity"><span class="ex-h"><i data-lucide="timer"></i>Activity guide</span><span class="ex-say">पाँच मिनट की group activity on shapes</span></button>
      </div></div>`;
    icons();
    stage.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => { if (busy) return; setMode(b.dataset.mode); runTyped(b.dataset.cmd); }));
  }

  // ============================================================ Controls
  function setMode(m) {
    interrupt(); if (!busy) resumeListening();
    mode = m;
    document.querySelectorAll(".mode").forEach((x) => x.setAttribute("aria-pressed", x.dataset.mode === m ? "true" : "false"));
  }
  $("modes").addEventListener("click", (e) => { const b = e.target.closest(".mode"); if (b) setMode(b.dataset.mode); });
  micBtn.addEventListener("click", () => {
    if (convoToggle.dataset.on === "true") return;
    if (recording) stopManualRecording(); else startManualRecording();
  });
  convoToggle.addEventListener("click", () => {
    const on = convoToggle.dataset.on !== "true";
    convoToggle.dataset.on = String(on);
    if (on) { if (recording) stopManualRecording(); startConversation(); }
    else { pauseCurrent(); stopConversation(); }
  });
  voiceToggle.addEventListener("click", () => {
    voiceOn = !voiceOn; voiceToggle.dataset.on = String(voiceOn);
    voiceIcon.setAttribute("data-lucide", voiceOn ? "volume-2" : "volume-x"); icons();
    if (!voiceOn) stopSpeaking();
  });
  voiceSelect.addEventListener("change", () => { voice = voiceSelect.value; });
  typeForm.addEventListener("submit", (e) => { e.preventDefault(); const t = textInput.value.trim(); textInput.value = ""; runTyped(t); });
  convoClear.addEventListener("click", () => { history.length = 0; convoLog.innerHTML = '<div class="convo-empty">Conversation yahan dikhegi.</div>'; });

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || document.activeElement === textInput || convoToggle.dataset.on === "true") return;
    e.preventDefault(); if (!recording && !busy) startManualRecording();
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || document.activeElement === textInput || convoToggle.dataset.on === "true") return;
    if (recording) stopManualRecording();
  });
  document.addEventListener("keydown", (e) => {
    if (document.activeElement === textInput) return;
    if (explainDeck) { if (e.code === "ArrowRight") { e.preventDefault(); manualGo(explainDeck.idx + 1); } else if (e.code === "ArrowLeft") { e.preventDefault(); manualGo(explainDeck.idx - 1); } }
    else if (quiz) { if (e.code === "ArrowRight") { e.preventDefault(); quizGo(quiz.idx + 1); } else if (e.code === "ArrowLeft") { e.preventDefault(); quizGo(quiz.idx - 1); } }
  });

  // ============================================================ init
  icons();
  convoLog.innerHTML = '<div class="convo-empty">Conversation yahan dikhegi.</div>';
  renderHero();
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    micBtn.disabled = true; convoToggle.disabled = true; micLabel.textContent = "Mic unsupported";
  }
})();
