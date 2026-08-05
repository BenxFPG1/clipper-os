"""Wie is er aan het woord, en waar staat die in beeld?

Aanroep: python3 gezichten.py <video> '[12.5, 40.2, ...]'
Uitvoer: JSON-lijst met per tijdstip {x, breedte, personen, breed} of null.

  x        horizontale positie 0..1 van de persoon die spreekt
  breedte  breedte van dat gezicht als fractie van het beeld (om de zoom te begrenzen)
  personen aantal gevonden personen
  breed    true als er meerdere mensen ver uit elkaar staan; dan mag er niet
           strak op één gezicht gekadreerd worden

Waarom niet simpelweg het grootste gezicht op één frame, zoals eerst: bij een
gesprek staan er twee mensen in beeld en dan koos hij willekeurig, of hij vond
op dat ene frame niets omdat iemand net wegkeek. Resultaat was een uitsnede
midden tussen twee hoofden in.

Daarom drie dingen anders:
1. Meerdere frames per shot, met de mediaan als uitkomst. Eén ongelukkig frame
   bepaalt niets meer.
2. Ook profielgezichten (en gespiegeld, voor de andere kant). In een gesprek
   kijkt men elkaar aan; frontaal alleen vindt die mensen niet.
3. Wie beweegt zijn mond? Dat is de spreker. We meten de verandering in de
   mondzone over de frames heen — dat is stemherkenning zonder een zwaar
   diarisatiemodel: het koppelt beeld aan wie er praat.
"""
import sys, json

try:
    import cv2
    import numpy as np
except ImportError:
    print("[]")
    sys.exit(0)

MONSTERS = 5          # frames per shot
SPREIDING = 0.5       # seconden rond het middelpunt
SAMEN = 0.14          # detecties dichter dan dit horen bij dezelfde persoon

pad = sys.argv[1]
tijden = json.loads(sys.argv[2])
cap = cv2.VideoCapture(pad)

haar_dir = cv2.data.haarcascades
frontaal = cv2.CascadeClassifier(haar_dir + "haarcascade_frontalface_default.xml")
profiel = cv2.CascadeClassifier(haar_dir + "haarcascade_profileface.xml")


def detecteer(frame):
    """Gezichten als (x, y, w, h) in pixels; frontaal plus beide profielen."""
    grijs = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    grijs = cv2.equalizeHist(grijs)
    gevonden = list(frontaal.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))
    gevonden += list(profiel.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))

    # De profielcascade kent maar één kijkrichting, dus spiegelen voor de andere.
    breedte = grijs.shape[1]
    for (x, y, w, h) in profiel.detectMultiScale(cv2.flip(grijs, 1), 1.2, 5, minSize=(60, 60)):
        gevonden.append((breedte - x - w, y, w, h))
    return gevonden


def mondbeweging(frames, vak):
    """Hoeveel verandert de mondzone over de frames? Veel = deze persoon praat."""
    x, y, w, h = vak
    uitsnedes = []
    for f in frames:
        mond = f[y + int(h * 0.55): y + h, x: x + w]
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

    # Detecties uit alle frames samenvoegen en groeperen per persoon: staat een
    # gezicht steeds op ongeveer dezelfde plek, dan is dat één persoon.
    groepen = []  # [{xs: [...], ws: [...], vak: (x,y,w,h)}]
    for frame in frames:
        for (x, y, w, h) in detecteer(frame):
            mid = (x + w / 2) / beeldbreedte
            for g in groepen:
                if abs(g["mid"] - mid) < SAMEN:
                    g["xs"].append(mid)
                    g["ws"].append(w / beeldbreedte)
                    g["mid"] = sum(g["xs"]) / len(g["xs"])
                    break
            else:
                groepen.append({"xs": [mid], "ws": [w / beeldbreedte], "mid": mid, "vak": (x, y, w, h)})

    # Ruis eruit: een persoon die maar op één van de vijf frames opduikt is
    # meestal een valse detectie op een textuur.
    echt = [g for g in groepen if len(g["xs"]) >= 2] or groepen
    if not echt:
        uit.append(None)
        continue

    for g in echt:
        g["beweging"] = mondbeweging(frames, g["vak"])

    spreker = max(echt, key=lambda g: (g["beweging"], len(g["xs"])))
    xs = sorted(spreker["xs"])
    x_mediaan = xs[len(xs) // 2]
    breedte = sorted(spreker["ws"])[len(spreker["ws"]) // 2]

    # Staan er meerdere mensen ver uit elkaar én is niet duidelijk wie praat?
    # Dan is strak kadreren op één gezicht juist fout: dan snijd je de ander weg
    # en beland je met een punch-in tussen twee hoofden in.
    posities = sorted(g["mid"] for g in echt)
    spreiding = posities[-1] - posities[0] if len(posities) > 1 else 0.0
    bewegingen = sorted((g["beweging"] for g in echt), reverse=True)
    duidelijk = len(bewegingen) < 2 or bewegingen[0] > bewegingen[1] * 1.6
    breed = spreiding > 0.30 and not duidelijk

    uit.append({
        "x": round(sum(posities) / len(posities) if breed else x_mediaan, 3),
        "breedte": round(breedte, 3),
        "personen": len(echt),
        "breed": breed,
    })

print(json.dumps(uit))
