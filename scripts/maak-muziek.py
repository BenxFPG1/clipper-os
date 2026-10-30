#!/usr/bin/env python3
"""
Maakt rechtenvrije hiphopbeats voor assets/muziek/luchtig/ (comedy).

Alles wordt hier gesynthetiseerd, er komt geen sample van buiten aan te pas.
De middentonen blijven bewust leeg: daar zit de stem. Vaste seed, dus dezelfde
uitvoer bij elke run.

Draaien: python3 scripts/maak-muziek.py
"""
import subprocess
from pathlib import Path

import numpy as np

SR = 44100
MAP = Path(__file__).resolve().parent.parent / 'assets' / 'muziek' / 'luchtig'


def hz(noot):
    return 440.0 * 2 ** ((noot - 69) / 12)


def mix(uit, geluid, t, gain=1.0):
    i = int(t * SR)
    if i >= len(uit):
        return
    n = min(len(geluid), len(uit) - i)
    uit[i:i + n] += geluid[:n] * gain


def laagdoorlaat(x, kantel):
    a = 1 - np.exp(-2 * np.pi * kantel / SR)
    y = np.empty_like(x)
    s = 0.0
    for i, v in enumerate(x):
        s += a * (v - s)
        y[i] = s
    return y


def kick():
    t = np.arange(int(0.32 * SR)) / SR
    f = 44 + 80 * np.exp(-t * 32)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def snare(rng):
    t = np.arange(int(0.2 * SR)) / SR
    ruis = rng.standard_normal(len(t))
    ruis = ruis - laagdoorlaat(ruis, 900)
    return (0.75 * ruis * np.exp(-t * 20) + 0.45 * np.sin(2 * np.pi * 185 * t) * np.exp(-t * 28))


def hat(rng, open_=False):
    t = np.arange(int((0.16 if open_ else 0.05) * SR)) / SR
    ruis = rng.standard_normal(len(t))
    return (ruis - laagdoorlaat(ruis, 6500)) * np.exp(-t * (22 if open_ else 95))


def bas(noot, duur):
    t = np.arange(int(duur * SR)) / SR
    f = hz(noot)
    x = np.sin(2 * np.pi * f * t) + 0.18 * np.sin(4 * np.pi * f * t)
    return np.tanh(1.5 * x) * np.minimum(t / 0.008, 1) * np.exp(-t * 1.6) * np.minimum((duur - t) / 0.03, 1)


def toets(noot, duur, rng):
    """Elektrische piano: FM met een snel wegzakkende boventoon."""
    t = np.arange(int(duur * SR)) / SR
    f = hz(noot) * (1 + rng.normal(0, 0.0006))
    index = 1.6 * np.exp(-t * 7)
    x = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    return x * np.minimum(t / 0.004, 1) * np.exp(-t * 2.2) * np.minimum((duur - t) / 0.05, 1)


def beat(bpm, swing, akkoorden, stabs, kicks, seed):
    rng = np.random.default_rng(seed)
    tel = 60 / bpm
    maten = 16
    uit = np.zeros(int(maten * 4 * tel * SR) + SR)
    drums = np.zeros_like(uit)
    keys = np.zeros_like(uit)
    laag = np.zeros_like(uit)
    trommel = snare(rng)
    schop = kick()

    def plek(maat, stap):
        """Stap in zestienden, met swing op de achterste achtsten."""
        t = (maat * 16 + stap) * tel / 4
        return t + (swing * tel / 4 if stap % 2 == 1 else 0)

    for maat in range(maten):
        akk = akkoorden[maat % len(akkoorden)]
        for s in kicks:
            mix(drums, schop, plek(maat, s), 0.95)
        for s in (4, 12):
            mix(drums, trommel, plek(maat, s), 0.6)
        for s in range(0, 16, 2):
            mix(drums, hat(rng), plek(maat, s), (0.2 if s % 4 == 0 else 0.13) * rng.uniform(0.8, 1.1))
        if maat % 4 == 3:
            mix(drums, hat(rng, True), plek(maat, 14), 0.16)
            mix(drums, trommel, plek(maat, 15), 0.22)
        mix(laag, bas(akk[0] - 12, tel * 1.6), plek(maat, 0), 0.5)
        mix(laag, bas(akk[0] - 12, tel * 0.9), plek(maat, 10), 0.42)
        for s, duur in stabs:
            for i, noot in enumerate(akk[1:]):
                mix(keys, toets(noot, tel * duur, rng), plek(maat, s) + i * 0.008, 0.11)

    keys = laagdoorlaat(keys, 2400)
    # Een dun plaatkraakje, onder de hoorgrens van de stem.
    kraak = np.zeros_like(uit)
    for t in rng.uniform(0, len(uit) / SR, 40 * maten):
        mix(kraak, rng.standard_normal(40) * 0.02, t)
    x = np.tanh(1.2 * (drums + laag + keys)) + kraak
    x = laagdoorlaat(x, 11000)
    return (x / np.max(np.abs(x)) * 0.89).astype(np.float32)


def bewaar(x, naam):
    MAP.mkdir(parents=True, exist_ok=True)
    pcm = (x * 32767).astype(np.int16)
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-',
         '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', str(MAP / naam)],
        input=pcm.tobytes(), check=True,
    )


# Mineur en rustig: droog en een beetje stoned, voor droge humor.
bewaar(beat(84, 0.32, [
    [57, 67, 72, 76], [53, 64, 69, 72], [50, 65, 69, 72], [52, 62, 68, 71],
], [(0, 2.2), (7, 1.2)], [0, 7, 10], 7), 'droog-84.mp3')

# Iets opener en sneller: voor de wat vrolijkere clips.
bewaar(beat(92, 0.26, [
    [48, 64, 67, 71], [57, 64, 67, 72], [53, 64, 69, 72], [55, 65, 67, 71],
], [(0, 1.4), (6, 1.0), (11, 1.0)], [0, 3, 8, 10], 11), 'bounce-92.mp3')
