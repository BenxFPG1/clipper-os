"""Woordtijden van een audiofragment, voor het uitlijnen van knippunten.

Aanroep: python3 align.py <wav> [model]
Uitvoer: JSON [{"w": woord, "s": start, "e": eind}] in seconden binnen het fragment.
"""
import sys, json

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("[]")
    sys.exit(3)

def lees_wav(pad):
    """De wav (16 kHz mono, s16 — zo maakt de Node-kant hem) zelf inlezen.

    faster-whisper decodeert anders via PyAV, en een nieuwere PyAV-versie in
    CI brak dat ("open() got an unexpected keyword argument 'metadata_…'"):
    elke transcriptie faalde en de ondertitels vielen terug op grove tijden.
    Een numpy-array doorgeven omzeilt PyAV volledig.
    """
    import wave
    import numpy as np
    with wave.open(pad, "rb") as w:
        if w.getsampwidth() != 2:
            return pad
        ruw = w.readframes(w.getnframes())
        kanalen = w.getnchannels()
        sr = w.getframerate()
    audio = np.frombuffer(ruw, dtype=np.int16).astype(np.float32) / 32768.0
    if kanalen > 1:
        audio = audio.reshape(-1, kanalen).mean(axis=1)
    if sr != 16000:
        # Lineair herbemonsteren; de Node-kant levert al 16 kHz, dit is vangnet.
        n = int(len(audio) * 16000 / sr)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


try:
    invoer = lees_wav(sys.argv[1]) if sys.argv[1].lower().endswith(".wav") else sys.argv[1]
except Exception:
    invoer = sys.argv[1]

model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "base", device="cpu", compute_type="int8")
segs, _ = model.transcribe(invoer, language="nl", word_timestamps=True, vad_filter=False)
uit = [
    {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)}
    for s in segs
    for w in (s.words or [])
]
print(json.dumps(uit))
