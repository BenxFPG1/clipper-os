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

MONSTERS = 5          # frames per tijdstip
SPREIDING = 0.5       # seconden rond het middelpunt
SAMEN = 0.14          # detecties dichter dan dit horen bij dezelfde persoon
DREMPEL = 0.7         # zekerheid waarboven YuNet-detecties meetellen

pad = sys.argv[1]
tijden = json.loads(sys.argv[2])
# Optioneel derde argument: hoeveel frames per tijdstip. Voor het volgen van een
# spreker vragen we véél tijdstippen met één frame elk (snel en fijnmazig); voor
# het bepalen van de kadrering juist weinig tijdstippen met vijf frames (robuust
# tegen één ongelukkig frame).
if len(sys.argv) > 3:
    MONSTERS = max(1, int(sys.argv[3]))
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
            # Kijkrichting uit de landmarks: staat de neus links van het midden
            # tussen de ogen, dan draait het hoofd naar links. Nodig voor de
            # kijkruimte-regel: iemand hoort ruimte te hebben in de richting
            # waarin hij kijkt, anders "praat hij tegen de rand".
            kijkt = 0.0
            ooghoogte = None
            if len(g) >= 10:
                ox1, oy1, ox2, oy2 = [float(v) for v in g[4:8]]
                nx = float(g[8])
                oogmid = (ox1 + ox2) / 2
                ooghoogte = (oy1 + oy2) / 2
                if w > 0:
                    kijkt = max(-1.0, min(1.0, (nx - oogmid) / (w * 0.25)))
            # Waar zit het gezicht visueel? Niet in het midden van het vak.
            # Bij een gedraaid hoofd loopt het detectievak door tot achter de
            # schedel; gemeten stond het vakmidden op 0,516 terwijl de neus op
            # 0,480 en het midden tussen de ogen op 0,496 lag. Een kader dat op
            # het vakmidden centreert zet de spreker daardoor zichtbaar uit het
            # midden — precies de klacht. De landmarks wijzen het echte
            # middelpunt aan.
            visueel = None
            if len(g) >= 10:
                oogR, oogL = float(g[4]), float(g[6])
                neus = float(g[8])
                visueel = (neus + (oogR + oogL) / 2) / 2
            uit.append(((x, y, w, hh), mond, kijkt, ooghoogte, visueel))
        return uit

    grijs = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    gevonden = list(frontaal.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))
    gevonden += list(profiel.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60)))
    breedte = grijs.shape[1]
    for (x, y, w, h) in profiel.detectMultiScale(cv2.flip(grijs, 1), 1.2, 5, minSize=(60, 60)):
        gevonden.append((breedte - x - w, y, w, h))
    # Zonder landmarks nemen we de onderste helft van het gezicht als mondzone,
    # en weten we niets over de kijkrichting.
    return [
        ((x, y, w, h), (x, y + int(h * 0.55), w, int(h * 0.45)), 0.0, y + h * 0.38, None)
        for (x, y, w, h) in gevonden
    ]


def zoekNaad(frames):
    """Zit er een verticale scheiding in beeld (split screen in de bron zelf)?

    Sommige interviews worden als twee camera's naast elkaar geleverd. Kadreer
    je daar blind een verticale uitsnede uit, dan krijg je een halve persoon,
    de naad, en een halve andere persoon.

    Maar een scherpe verticale rand is nog geen split screen: een deurpost, een
    kastrand of een naad in de lambrisering geeft precies hetzelfde signaal. Dat
    is niet theoretisch — het sneed hier een gesprek doormidden op een houtnaad
    achter het hoofd van de spreker. Vandaar drie eisen bovenop de rand zelf:

    1. De rand moet er ver bovenuit springen, niet net.
    2. Hij moet alleen staan: is de buurt ook druk, dan kijk je naar structuur
       (een kast, een radiator) en niet naar een montagegrens.
    3. Links en rechts moeten wérkelijk verschillende beelden zijn. Twee camera's
       leveren andere kleuren en andere helderheid; één kamer niet.

    Bij twijfel: geen naad. Een gemiste split screen kost een middelmatige
    uitsnede, een verzonnen naad kost een half hoofd.
    """
    scores = None
    for f in frames[:3]:
        grijs = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype("float32")
        kolom = np.mean(np.abs(np.diff(grijs, axis=1)), axis=0)
        scores = kolom if scores is None else scores + kolom
    if scores is None or scores.size < 40:
        return None

    b = scores.size
    rand = int(b * 0.18)
    midden = scores[rand:b - rand]
    if midden.size == 0:
        return None

    piek = int(np.argmax(midden)) + rand
    mediaan = float(np.median(scores))
    if mediaan <= 0 or scores[piek] < mediaan * 12:
        return None

    # 2. Staat de piek alleen? Kijk naar de omgeving, met de piek zelf eruit.
    marge = max(3, int(b * 0.02))
    omgeving = np.concatenate([
        scores[max(0, piek - marge): max(0, piek - 2)],
        scores[min(b, piek + 3): min(b, piek + marge)],
    ])
    if omgeving.size and float(np.max(omgeving)) > scores[piek] * 0.45:
        return None

    # 3. Zijn het twee verschillende beelden? Vergelijk de kleurverdeling van
    #    beide helften; twee camera's lijken nooit zo op elkaar als twee helften
    #    van dezelfde kamer.
    f = frames[0]
    links = f[:, :piek]
    rechts = f[:, piek + 1:]
    if links.size == 0 or rechts.size == 0:
        return None

    verschil = 0.0
    for kanaal in range(3):
        hl = cv2.calcHist([links], [kanaal], None, [32], [0, 256]).flatten()
        hr = cv2.calcHist([rechts], [kanaal], None, [32], [0, 256]).flatten()
        hl = hl / max(1.0, hl.sum())
        hr = hr / max(1.0, hr.sum())
        verschil += float(np.sum(np.abs(hl - hr))) / 2
    if verschil / 3 < 0.35:
        return None

    return round(piek / b, 4)


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
    beeldhoogte = frames[0].shape[0]
    groepen = []
    for frame in frames:
        for (vak, mond, kijkt, ooghoogte, visueel) in detecteer(frame):
            x, y, w, h = vak
            # Het visuele middelpunt als de landmarks er zijn, anders het vak.
            mid = (visueel if visueel is not None else x + w / 2) / beeldbreedte
            oog = (ooghoogte if ooghoogte is not None else y + h * 0.38) / beeldhoogte
            for g in groepen:
                if abs(g["mid"] - mid) < SAMEN:
                    g["xs"].append(mid)
                    g["ws"].append(w / beeldbreedte)
                    g["ogen"].append(oog)
                    g["kijkt"].append(kijkt)
                    g["tops"].append(y / beeldhoogte)
                    g["hs"].append(h / beeldhoogte)
                    g["mid"] = sum(g["xs"]) / len(g["xs"])
                    break
            else:
                groepen.append({
                    "xs": [mid], "ws": [w / beeldbreedte], "mid": mid,
                    "tops": [y / beeldhoogte], "hs": [h / beeldhoogte],
                    "ogen": [oog], "kijkt": [kijkt],
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

    # Zit er een naad in beeld, dan kadreren we binnen het paneel waar de
    # spreker staat, en rekenen we zijn positie om naar dat paneel.
    naad = zoekNaad(frames)
    paneel = None
    if naad is not None and 0.15 < naad < 0.85:
        # De kant waar de spreker staat, bepaald op zijn middelpunt. Raakt zijn
        # gezichtsvak de naad net (dat gebeurt: het vak van de detector zit
        # ruimer dan het gezicht), dan is dat geen reden om het paneel te laten
        # vallen — de naad in beeld laten is altijd het slechtste van de twee.
        # Ligt het gezicht écht grotendeels aan de andere kant, dan klopt de
        # naad niet en kadreren we op het hele beeld.
        overlap = (
            max(0.0, (x_mediaan + breedte / 2) - naad)
            if x_mediaan < naad
            else max(0.0, naad - (x_mediaan - breedte / 2))
        )
        if breedte <= 0 or overlap / breedte < 0.45:
            paneel = [0.0, naad] if x_mediaan < naad else [naad, 1.0]
            breed = False

    ogen = sorted(spreker["ogen"])
    kijkt = sorted(spreker["kijkt"])
    tops = sorted(spreker["tops"])
    hoogtes = sorted(spreker["hs"])

    uit.append({
        "x": round(x_mediaan, 3),
        "breedte": round(breedte, 3),
        "oog": round(ogen[len(ogen) // 2], 3),
        "kijkt": round(kijkt[len(kijkt) // 2], 3),
        "top": round(tops[len(tops) // 2], 3),
        "hoogte": round(hoogtes[len(hoogtes) // 2], 3),
        "personen": len(echt),
        "breed": breed,
        "paneel": paneel,
        "model": "yunet" if yunet is not None else "haar",
    })

print(json.dumps(uit))
