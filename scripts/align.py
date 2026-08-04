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

model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "base", device="cpu", compute_type="int8")
segs, _ = model.transcribe(sys.argv[1], language="nl", word_timestamps=True, vad_filter=False)
uit = [
    {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)}
    for s in segs
    for w in (s.words or [])
]
print(json.dumps(uit))
