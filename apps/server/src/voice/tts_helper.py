# Harv's voice (docs/review/voice-plan.md V2): one warm process, JSON lines on stdin/stdout, no port.
#   {"id": 1, "cmd": "speak", "text": "...", "lang": "en"|"sk", "out": "<wav path>", "convert": true|false,
#    "device": "cuda"|"cpu"}
#   {"id": 2, "cmd": "prepare"}   (install: the reference voice, Seed-VC's models, one test sentence)
#   {"id": 3, "cmd": "status"}
# Every answer is {"id": ..., "ok": true, ...} or {"id": ..., "ok": false, "error": "..."}.
#
# English is Piper's en_GB northern_english_male as it is. Slovak is Piper's lili, converted by Seed-VC
# (GPL-3.0, pinned commit, run as a separate program) into that same northern man, so Harv sounds like
# one person in both languages (the user's pick, 2026-11-15). Seed-VC's own files are not changed: what
# its old code needs from newer libraries is patched here, in memory.
import json
import os
import sys
import time
import wave

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
# Answers only on the real stdout: Seed-VC and the libraries print as they load; that goes to stderr.
ANSWERS = sys.stdout
sys.stdout = sys.stderr

HOME = os.environ["HARV_TTS_HOME"]
SEEDVC = os.path.join(HOME, "seed-vc")
VOICES = os.path.join(HOME, "voices")
REF = os.path.join(HOME, "ref-northern.wav")
# Each voice and its speed (Piper's length_scale; the user's picks: a bit faster, lili the fastest).
SPEC = {"en": ("en_GB-northern_english_male-medium", 0.82), "sk": ("sk_SK-lili-medium", float(os.environ.get("HARV_SK_SCALE", "0.7")))}
REF_TEXT = (
    "Good evening. I have checked the computer and everything is running as it should. "
    "The graphics card is cool, the drives have plenty of space, and nothing unusual is starting at login. "
    "Your calendar is clear until tomorrow morning, when you have a meeting at nine. "
    "I have also looked at the weather: it will be cold and foggy, so leave a little earlier than usual. "
    "If you need anything else tonight, just ask."
)
# Seed-VC copies the voice from this much of the reference; shorter is faster for every sentence.
REF_SECONDS = int(os.environ.get("HARV_VC_REF_SECONDS", "20"))
DIFFUSION_STEPS = int(os.environ.get("HARV_VC_STEPS", "10"))
SR = 22050

voices = {}
vc = None
vc_device = None


def piper_voice(lang):
    if lang not in voices:
        from piper import PiperVoice

        name, _ = SPEC[lang]
        voices[lang] = PiperVoice.load(os.path.join(VOICES, f"{name}.onnx"))
    return voices[lang]


def synthesize(lang, text):
    """Piper: text to float32 samples at 22050 Hz."""
    import numpy as np
    from piper import SynthesisConfig

    voice = piper_voice(lang)
    config = SynthesisConfig(length_scale=SPEC[lang][1])
    parts = [chunk.audio_float_array for chunk in voice.synthesize(text, syn_config=config)]
    rate = voice.config.sample_rate
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    if rate != SR:
        import librosa

        audio = librosa.resample(audio, orig_sr=rate, target_sr=SR)
    return audio.astype(np.float32)


def write_wav(path, audio):
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def load_vc(device):
    """Seed-VC's models, once, plus everything about the target voice that never changes."""
    global vc, vc_device
    if vc is not None and vc_device == device:
        return vc
    import argparse

    import librosa
    import torch
    import torchaudio

    # Seed-VC downloads into ./checkpoints: keep that in Harv's folder (a short path for Windows too).
    os.chdir(HOME)
    sys.path.insert(0, SEEDVC)
    # Its BigVGAN loader still requires two arguments newer huggingface_hub no longer passes.
    from modules.bigvgan import bigvgan as bv

    original = bv.BigVGAN._from_pretrained.__func__

    def from_pretrained(cls, *args, proxies=None, resume_download=False, **kwargs):
        return original(cls, *args, proxies=proxies, resume_download=resume_download, **kwargs)

    bv.BigVGAN._from_pretrained = classmethod(from_pretrained)

    import inference as seed

    seed.device = torch.device(device)
    args = argparse.Namespace(fp16=device == "cuda", f0_condition=False, checkpoint=None, config=None)
    model, semantic_fn, _f0, vocoder_fn, campplus, mel_fn, _args = seed.load_models(args)

    ref = librosa.load(REF, sr=SR)[0][: SR * REF_SECONDS]
    ref = torch.tensor(ref).unsqueeze(0).float().to(seed.device)
    ref16 = torchaudio.functional.resample(ref, SR, 16000)
    with torch.no_grad():
        s_ori = semantic_fn(ref16)
        mel2 = mel_fn(ref.float())
        feat2 = torchaudio.compliance.kaldi.fbank(ref16, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
        style2 = campplus(feat2.unsqueeze(0))
        prompt, *_ = model.length_regulator(s_ori, ylens=torch.LongTensor([mel2.size(2)]).to(seed.device), n_quantizers=3, f0=None)
    vc = dict(seed=seed, model=model, semantic_fn=semantic_fn, vocoder=vocoder_fn, mel_fn=mel_fn, mel2=mel2, style2=style2, prompt=prompt)
    vc_device = device
    return vc


def convert(audio, device):
    """Piper's lili → the northern man (one pass: a spoken sentence is far below Seed-VC's 30 s window)."""
    import torch
    import torchaudio

    v = load_vc(device)
    seed = v["seed"]
    with torch.no_grad():
        src = torch.tensor(audio).unsqueeze(0).float().to(seed.device)
        src16 = torchaudio.functional.resample(src, SR, 16000)
        s_alt = v["semantic_fn"](src16)
        mel = v["mel_fn"](src.float())
        cond, *_ = v["model"].length_regulator(s_alt, ylens=torch.LongTensor([mel.size(2)]).to(seed.device), n_quantizers=3, f0=None)
        cat = torch.cat([v["prompt"], cond], dim=1)
        with torch.autocast(device_type=seed.device.type, dtype=torch.float16 if device == "cuda" else torch.float32):
            out = v["model"].cfm.inference(
                cat, torch.LongTensor([cat.size(1)]).to(seed.device), v["mel2"], v["style2"], None, DIFFUSION_STEPS, inference_cfg_rate=0.7
            )
            out = out[:, :, v["mel2"].size(-1) :]
        wave_out = v["vocoder"](out.float()).squeeze()
    return wave_out.cpu().numpy().astype("float32")


def speak(req):
    lang = req.get("lang") if req.get("lang") in SPEC else "en"
    started = time.time()
    audio = synthesize(lang, req["text"])
    converted = False
    fell_back = None
    if lang == "sk" and req.get("convert"):
        device = req.get("device") or "cpu"
        try:
            audio = convert(audio, device)
            converted = True
        except Exception as err:  # a GPU error: the CPU always works; a broken install: lili as she is
            if device == "cuda":
                try:
                    audio = convert(audio, "cpu")
                    converted = True
                except Exception as err2:
                    fell_back = str(err2)[:200]
            else:
                fell_back = str(err)[:200]
    write_wav(req["out"], audio)
    answer = {"ok": True, "seconds": round(time.time() - started, 2), "duration": round(len(audio) / SR, 2), "converted": converted, "device": vc_device}
    if fell_back:
        answer["fellBack"] = fell_back
    return answer


def prepare(req):
    """Install: the reference (the northern man reading), Seed-VC's models (downloaded once), a test."""
    write_wav(REF, synthesize("en", REF_TEXT))
    out = os.path.join(HOME, "test.wav")
    english = bool(req.get("english"))
    text, lang = ("Good evening, everything is running as it should.", "en") if english else ("Dobrý večer, všetko beží, ako má.", "sk")
    answer = speak({"text": text, "lang": lang, "out": out, "convert": bool(req.get("convert")), "device": req.get("device") or "cpu"})
    if req.get("convert") and not answer.get("converted"):
        return {"ok": False, "error": "Seed-VC didn't run: " + str(answer.get("fellBack", "unknown"))}
    os.remove(out)
    return answer


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "speak":
                answer = speak(req)
            elif cmd == "prepare":
                answer = prepare(req)
            elif cmd == "warm":
                # The user just spoke: load everything now, while Harv thinks, so the reply speaks at once.
                for lang in req.get("langs") or SPEC:
                    piper_voice(lang)
                if req.get("convert"):
                    load_vc(req.get("device") or "cuda")
                answer = {"ok": True, "device": vc_device}
            elif cmd == "status":
                answer = {"ok": True, "device": vc_device}
            else:
                answer = {"ok": False, "error": f"unknown command {cmd!r}"}
        except Exception as err:
            answer = {"ok": False, "error": f"{type(err).__name__}: {err}"[:300]}
        answer["id"] = req.get("id")
        ANSWERS.write(json.dumps(answer, ensure_ascii=False) + "\n")
        ANSWERS.flush()


if __name__ == "__main__":
    main()
