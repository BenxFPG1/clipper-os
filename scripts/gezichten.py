"""Wie is er aan het woord, en waar staat die in beeld?

Aanroep: python3 gezichten.py <video> '[12.5, 40.2, ...]'
Uitvoer: JSON-lijst met per tijdstip {x, breedte, personen, breed} of null.

  x        horizontale positie 0..1 van de persoon die spreekt
  breedte  breedte van dat gezicht als fractie van het beeld (begrenst de zoom)
  personen aantal gevonden personen
  breed    true als er meerdere mensen ver uit elkaar staan zonder duidelijke
           spreker; dan mag er niet strak op één gezicht gekadreerd worden

Detectie gaat via YuNet, het neurale gezichtsmodel dat bij OpenCV hoort. De
Haar-cascades die hier eerst stonden missen iemand zodra die wegdraait, en juist
in een gesprek kijkt men elkaar aan — dat leverde shots op waarin de spreker
half buiten beeld viel. YuNet vindt gedraaide gezichten wel en geeft bovendien
landmarks terug, waaronder de mondhoeken. Daarmee weten we niet alleen wáár
iemand staat maar ook wie er praat: de mond die beweegt is de spreker.

Ontbreekt het model of is de OpenCV-versie te oud, dan valt hij terug op de
cascades. Dat is minder goed, maar beter dan blind het midden pakken.
"""
import os
import sys
import json

try:
    import cv2
    import numpy as np
except ImportError:
    print("[]")
    sys.exit(0)

MONSTERS = 5          # frames per shot
SPREIDING = 0.5       # seconden rond het middelpunt
SAMEN = 0.14          # detecties dichter dan dit horen bij dezelfde persoon
DREMPEL = 0.7         # zekerheid waarboven YuNet-detecties meetellen

pad = sys.argv[1]
tijden = json.loads(sys.argv[2])
cap = cv2.VideoCapture(pad)

MODEL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets", "modellen", "face_detection_yunet_2023mar.onnx",
)

yunet = None
if hasattr(cv2, "FaceDetectorYN") and os.path.exists(MODEL):
    try:
        yunet = cv2.FaceDetectorYN.create(MODEL, "", (320, 320), DREMPEL, 0.3, 5000)
    except Exception:
        yunet = None

if yunet is None:
    haar_dir = cv2.data.haarcascades
    frontaal = cv2.CascadeClassifier(haar_dir + "haarcascade_frontalface_default.xml")
    profiel = cv2.CascadeClassifier(haar_dir + "haarcascade_profileface.xml")


def detecteer(frame):
    """Gezichten als (x, y, w, h) in pixels, plus de mondzone als die bekend is."""
    if yunet is not None:
        h, b = frame.shape[:2]
        yunet.setInputSize((b, h))
        _, gezichten = yunet.detect(frame)
        uit = []
        for g in gezichten if gezichten is not None else []:
            x, y, w, hh = [int(v) for v in g[:4]]
            # Landmarks 6..9 zijn de linker- en rechtermondhoek.
            mond = None
            if len(g) >= 14:
                mx1, my1, mx2, my2 = [int(v) for v in g[10:14]]
                breed = max(24, abs(mx2 - mx1) * 2)
                hoog = max(16, int(breed * 0.6))
                cx, cy = (mx1 + mx2) // 2, (my1 + my2) // 2
                mond = (cx - breed // 2, cy - hoog // 2, breed, hoog)
            uit.append(((x, y, w, hh), mond))
        return uit

    grijs = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    gevonden = list(frontaal.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))
    gevonden += list(profiel.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))
    breedte = grijs.shape[1]
    for (x, y, w, h) in profiel.detectMultiScale(cv2.flip(grijs, 1), 1.2, 5, minSize=(60, 60)):
        gevonden.append((breedte - x - w, y, w, h))
    # Zonder landmarks nemen we de onderste helft van het gezicht als mondzone.
    return [((x, y, w, h), (x, y + int(h * 0.55), w, int(h * 0.45))) for (x, y, w, h) in gevonden]


def mondbeweging(frames, vak):
    """Hoeveel verandert de mondzone over de frames? Veel = deze persoon praat."""
    x, y, w, h = [max(0, int(v)) for v in vak]
    uitsnedes = []
    for f in frames:
        mond = f[y: y + h, x: x + w]
        if mond.size == 0:
            continue
        klein = cv2.resize(cv2.cvtColor(mond, cv2.COLOR_BGR2GRAY), (32, 16)).astype("float32")
        uitsnedes.append(klein)
    if len(uitsnedes) < 2:
        return 0.0
    verschillen = [float(np.mean(np.abs(uitsnedes[i] - uitsnedes[i - 1]))) for i in range(1, len(uitsnedes))]
    return sum(verschillen) / len(verschillen)


uit = []
for t in tijden:
    frames = []
    for k in range(MONSTERS):
        moment = max(0.0, float(t) - SPREIDING + (2 * SPREIDING) * k / max(1, MONSTERS - 1))
        cap.set(cv2.CAP_PROP_POS_MSEC, moment * 1000)
        ok, frame = cap.read()
        if ok:
            frames.append(frame)

    if not frames:
        uit.append(None)
        continue

    beeldbreedte = frames[0].shape[1]

    # Detecties uit alle frames groeperen per persoon: staat een gezicht steeds
    # op ongeveer dezelfde plek, dan is dat één persoon.
    groepen = []
    for frame in frames:
        for (vak, mond) in detecteer(frame):
            x, y, w, h = vak
            mid = (x + w / 2) / beeldbreedte
            for g in groepen:
                if abs(g["mid"] - mid) < SAMEN:
                    g["xs"].append(mid)
                    g["ws"].append(w / beeldbreedte)
                    g["mid"] = sum(g["xs"]) / len(g["xs"])
                    break
            else:
                groepen.append({
                    "xs": [mid], "ws": [w / beeldbreedte], "mid": mid,
                    "mond": mond or (x, y + int(h * 0.55), w, max(1, int(h * 0.45))),
                })

    # Een persoon die op één van de vijf frames opduikt is meestal ruis, en een
    # gezichtje van een paar procent breed is iemand op de achtergrond of een
    # weerspiegeling — die mag niet bepalen dat het beeld "te breed" is om op
    # de spreker in te zoomen.
    echt = [
        g for g in groepen
        if len(g["xs"]) >= 2 and sorted(g["ws"])[len(g["ws"]) // 2] >= 0.05
    ] or [g for g in groepen if len(g["xs"]) >= 2] or groepen
    if not echt:
        uit.append(None)
        continue

    for g in echt:
        g["beweging"] = mondbeweging(frames, g["mond"])

    spreker = max(echt, key=lambda g: (g["beweging"], len(g["xs"])))
    xs = sorted(spreker["xs"])
    x_mediaan = xs[len(xs) // 2]
    breedte = sorted(spreker["ws"])[len(spreker["ws"]) // 2]

    # Meerdere mensen in beeld? Dan kadreren we juist wél op de spreker. Het
    # gemiddelde nemen leverde precies de mislukte uitsnede op die je in een
    # tweeshot ziet: twee halve mensen en niemand in focus. Nu de mond de
    # spreker aanwijst, is die keuze betrouwbaar genoeg om op te durven staan.
    posities = sorted(g["mid"] for g in echt)
    spreiding = posities[-1] - posities[0] if len(posities) > 1 else 0.0
    bewegingen = sorted((g["beweging"] for g in echt), reverse=True)
    duidelijk = len(bewegingen) < 2 or bewegingen[0] > bewegingen[1] * 1.6
    breed = spreiding > 0.30 and not duidelijk

    uit.append({
        "x": round(x_mediaan, 3),
        "breedte": round(breedte, 3),
        "personen": len(echt),
        "breed": breed,
        "model": "yunet" if yunet is not None else "haar",
    })

print(json.dumps(uit))
