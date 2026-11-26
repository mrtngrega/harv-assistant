# Harv's speech-to-text helper (docs/review/voice-plan.md V1a): faster-whisper in one warm process.
# Talks JSON lines on stdin/stdout, no port. Commands:
#   {"id": 1, "cmd": "transcribe", "path": "...", "format": "text"|"srt"|"words", "language": null|"sk"|"en",
#    "device": "cuda"|"cpu", "compute": "float16"|"int8_float16"|"int8"}
#   {"id": 2, "cmd": "unload"}    {"id": 3, "cmd": "status"}
# Every answer is {"id": ..., "ok": true, ...} or {"id": ..., "ok": false, "error": "..."}.
# The model files live in HARV_VOICE_MODELS; after the install nothing goes to the network.
import glob
import json
import os
import site
import sys
import time

MODEL = os.environ.get("HARV_VOICE_MODEL", "large-v3-turbo")
MODELS = os.environ.get("HARV_VOICE_MODELS") or None

# The CUDA libraries come from pip (nvidia-cublas-cu12, nvidia-cudnn-cu12): Windows has to be told where.
if sys.platform == "win32":
    for sp in site.getsitepackages():
        for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
            os.add_dll_directory(d)
            os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel  # noqa: E402

# Windows pipes default to the old code page: Slovak letters would reach Harv as "Dobr� ve�er".
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

loaded = None  # (device, compute, model)


def load(device, compute):
    global loaded
    if loaded and loaded[0] == device and loaded[1] == compute:
        return loaded[2]
    unload()
    model = WhisperModel(MODEL, device=device, compute_type=compute, download_root=MODELS)
    loaded = (device, compute, model)
    return model


def unload():
    global loaded
    loaded = None
    try:
        import gc

        gc.collect()
    except Exception:
        pass


# Close to Slovak: Whisper names these for short Slovak phrases, so they never win on their own.
NEAR_SLOVAK = ("sk", "en", "cs", "pl")


def pick_language(model, path, wanted, clip=False):
    """
    A spoken clip: Slovak or English only (a short Slovak phrase must not come back as Czech or Polish).
    A file (a reel, a recording): Whisper's own pick when it clearly hears another language (the full
    review, K7: a German reel came out as Slovak nonsense); else Slovak or English as for clips.
    """
    if wanted:
        return wanted
    try:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(path, sampling_rate=16000)
        _, _, probs = model.detect_language(audio, vad_filter=True)
        scores = dict(probs)
        if not clip and probs:
            top, p = max(probs, key=lambda x: x[1])
            if top not in NEAR_SLOVAK and p >= 0.5:
                return top
        return "sk" if scores.get("sk", 0) >= scores.get("en", 0) else "en"
    except Exception:
        return None


def stamp(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def transcribe(req):
    device = req.get("device") or "cpu"
    compute = req.get("compute") or ("float16" if device == "cuda" else "int8")
    try:
        model = load(device, compute)
    except Exception as err:
        if device == "cpu":
            raise
        # Out of memory or a missing GPU library: the CPU always works.
        device, compute = "cpu", "int8"
        model = load(device, compute)
        req["_fell_back"] = str(err)[:200]
    language = pick_language(model, req["path"], req.get("language"), bool(req.get("clip")))
    started = time.time()
    words_wanted = req.get("format") == "words"

    def run(model):
        segments, info = model.transcribe(
            req["path"],
            language=language,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=words_wanted,
        )
        parts = []
        words = []
        for seg in segments:
            # Whisper invents text on silence: drop what is most likely not speech.
            if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
                continue
            text = seg.text.strip()
            if text:
                parts.append((seg.start, seg.end, text))
                for w in seg.words or []:
                    if w.word.strip():
                        words.append([round(w.start, 3), round(w.end, 3), w.word])
        return info, parts, words

    try:
        info, parts, words = run(model)
    except Exception as err:
        # The segments run lazily: a GPU running out of memory mid-clip (another program took it)
        # shows up here, not at load. Once more on the CPU (the full review, K6).
        if device == "cpu":
            raise
        device, compute = "cpu", "int8"
        info, parts, words = run(load(device, compute))
        req["_fell_back"] = str(err)[:200]
    if words_wanted:
        out = packed(words)
    elif req.get("format") == "srt":
        out = "\n\n".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{t}" for i, (a, b, t) in enumerate(parts, 1))
    else:
        out = " ".join(t for _, _, t in parts)
    answer = {
        "text": out,
        "language": info.language,
        "duration": round(info.duration, 1),
        "seconds": round(time.time() - started, 1),
        "device": device,
    }
    if words_wanted:
        answer["words"] = words
    if "_fell_back" in req:
        answer["fellBack"] = req["_fell_back"]
    return answer


def packed(words, pause=0.5, sentence=3.0, longest=12.0):
    """One line per phrase: [start-end] text. A phrase ends at a pause of half a second or more, at a
    sentence's end once it's 3 s long, or at 12 s (fast talk over music has no pauses). The reading
    view for cutting: a cut goes at a phrase edge or a word edge, never inside a word."""
    lines, phrase = [], []
    for w in words:
        if phrase:
            gap = w[0] - phrase[-1][1]
            span = phrase[-1][1] - phrase[0][0]
            ended = phrase[-1][2].rstrip().endswith((".", "?", "!"))
            if gap >= pause or (ended and span >= sentence) or span >= longest:
                lines.append(phrase)
                phrase = []
        phrase.append(w)
    if phrase:
        lines.append(phrase)
    return "\n".join(f"[{p[0][0]:.2f}-{p[-1][1]:.2f}] {''.join(w[2] for w in p).strip()}" for p in lines)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "transcribe":
                answer = transcribe(req)
            elif cmd == "unload":
                unload()
                answer = {}
            elif cmd == "status":
                answer = {"loaded": bool(loaded), "device": loaded[0] if loaded else None, "model": MODEL}
            else:
                raise ValueError(f"unknown command {cmd!r}")
            out = {"id": req.get("id"), "ok": True, **answer}
        except Exception as err:
            out = {"id": req.get("id"), "ok": False, "error": f"{type(err).__name__}: {err}"[:500]}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
