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
SPREKERMODUS = len(sys.argv) > 2 and sys.argv[2] == "--sprekers"
tijden = [] if SPREKERMODUS else json.loads(sys.argv[2])
# Optioneel derde argument: hoeveel frames per tijdstip. Voor het volgen van een
# spreker vragen we véél tijdstippen met één frame elk (snel en fijnmazig); voor
# het bepalen van de kadrering juist weinig tijdstippen met vijf frames (robuust
# tegen één ongelukkig frame).
if len(sys.argv) > 3 and not SPREKERMODUS:
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
    """Gezichten als (x, y, w, h) in pixels, plus de mondzone als die bekend is.

    Vindt de eerste ronde niets, dan nog één keer op een twee keer vergroot
    beeld: YuNet mist gezichten onder ~30 px, en in een wijde studio-opname is
    het gezicht van de spreker precies zo klein. Zonder die tweede ronde werd
    een wijd shot "geen gezicht" en daarmee ten onrechte een graphic.
    """
    gevonden = detecteer_eenmaal(frame)
    if gevonden or frame.shape[1] > 2400:
        return gevonden
    groot = cv2.resize(frame, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    terug = []
    for ((x, y, w, h), mond, kijkt, ooghoogte, visueel) in detecteer_eenmaal(groot):
        terug.append((
            (x // 2, y // 2, max(1, w // 2), max(1, h // 2)),
            tuple(v // 2 for v in mond) if mond else None,
            kijkt,
            ooghoogte / 2 if ooghoogte is not None else None,
            visueel / 2 if visueel is not None else None,
        ))
    return terug


def detecteer_eenmaal(frame):
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


def grijs_uitsnede(frame, vak, maat=(32, 16)):
    x, y, w, h = [max(0, int(v)) for v in vak]
    stuk = frame[y: y + h, x: x + w]
    if stuk.size == 0 or w < 4 or h < 4:
        return None
    klein = cv2.resize(cv2.cvtColor(stuk, cv2.COLOR_BGR2GRAY), maat).astype("float32")
    # Belichting eruit: alleen de vorm telt, niet of de lamp flikkert.
    return klein - float(np.mean(klein))


def sprekermeting(van, tot, stap):
    """Alle gezichten in [van, tot], elke `stap` seconde, met per gezicht de
    mondbeweging t.o.v. het vorige monster. De mondzone min de oogzone van
    hetzelfde gezicht: een hoofd dat knikt of draait beweegt beide, een mond
    die praat alleen de onderste.

    Veel bronnen (podcasts met meerdere camera's) knippen zelf tussen
    camerastandpunten. Een persoon op x=0,4 in het ene standpunt is dan een
    ander dan op x=0,4 in het volgende; daarom worden de bronknippen per frame
    gemeten (exacte tijd) en beginnen alle gezichtssporen na een knip opnieuw.

    Uitvoer: {van, tot, stap, personen: [{id, scene, x, breedte, oog, top,
    hoogte, n, monsters: [[t, x, mond|null], ...]}], knippen: [t, ...]}.
    """
    cap.set(cv2.CAP_PROP_POS_MSEC, van * 1000)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    elke = max(1, int(round(stap * fps)))
    # Waar staat de lezer werkelijk? (seek landt op een frame, niet op van)
    start_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    t0 = start_ms / 1000.0 if start_ms and start_ms > 0 else van
    sporen = []
    afgesloten = []
    knippen = []
    scene = 0
    monsters_per_scene = {0: 0}
    vorig_klein = None
    recent = []
    n = 0
    sinds_knip = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = t0 + n / fps
        n += 1
        if t > tot:
            break
        # Bronknip per frame: het hele beeld verandert in één stap.
        # Relatief aan de gewone beweging van de laatste frames: een camera-
        # wissel binnen dezelfde kamer verandert minder dan een wissel naar
        # een ander decor, maar altijd veel meer dan beweging.
        mini = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36)).astype("float32")
        knip = False
        if vorig_klein is not None:
            d = float(np.mean(np.abs(mini - vorig_klein)))
            gewoon = sorted(recent)[len(recent) // 2] if recent else 2.0
            knip = d > max(12.0, 5.0 * gewoon)
            recent.append(d)
            if len(recent) > 25:
                recent.pop(0)
        vorig_klein = mini
        if knip and knippen and t - knippen[-1] < 0.3:
            # Een overgang (flits, overvloeier) is een reeks "knippen" achter
            # elkaar: dat is één wissel, en het nieuwe standpunt begint pas
            # als het beeld weer stilstaat.
            knippen[-1] = round(t, 3)
            sporen = []
            monsters_per_scene[scene] = 0
            sinds_knip = 0
        elif knip and t - van > 0.05:
            knippen.append(round(t, 3))
            afgesloten.extend(sporen)
            sporen = []
            scene += 1
            monsters_per_scene[scene] = 0
            sinds_knip = 0
        # Monster direct na een knip, daarna elke `stap`.
        if sinds_knip % elke:
            sinds_knip += 1
            continue
        sinds_knip += 1
        monsters_per_scene[scene] += 1
        bb = frame.shape[1]
        schaal = 960.0 / bb if bb > 960 else 1.0
        beeld = cv2.resize(frame, None, fx=schaal, fy=schaal) if schaal < 1 else frame
        kb = beeld.shape[1]
        kh = beeld.shape[0]
        gebruikt = set()
        for (vak, mond, kijkt, ooghoogte, visueel) in detecteer(beeld):
            x, y, w, h = vak
            if w / kb < 0.025:
                continue
            mid = (visueel if visueel is not None else x + w / 2) / kb
            mondvak = mond or (x, y + int(h * 0.55), w, max(1, int(h * 0.45)))
            oogvak = (x, y + int(h * 0.2), w, max(1, int(h * 0.3)))
            kandidaten = [i for i, sp in enumerate(sporen) if i not in gebruikt and abs(sp["mid"] - mid) < SAMEN]
            if kandidaten:
                i = min(kandidaten, key=lambda k: abs(sporen[k]["mid"] - mid))
            else:
                sporen.append({"scene": scene, "mid": mid, "xs": [], "ws": [], "ogen": [], "tops": [], "hs": [], "monsters": [], "vm": None, "vo": None, "vt": None})
                i = len(sporen) - 1
            gebruikt.add(i)
            sp = sporen[i]
            # De vakken gladgestreken over het spoor: de landmarks trillen een
            # paar pixels per frame, en op een klein gezicht is dat al
            # "mondbeweging". Een stilstaand gezicht moet ~0 geven.
            glad = lambda oud, nieuw: nieuw if oud is None else tuple(0.7 * a + 0.3 * b for a, b in zip(oud, nieuw))
            sp["mvak"] = glad(sp.get("mvak"), mondvak)
            sp["ovak"] = glad(sp.get("ovak"), oogvak)
            m_now = grijs_uitsnede(beeld, sp["mvak"])
            o_now = grijs_uitsnede(beeld, sp["ovak"])
            energie = None
            if sp["vm"] is not None and m_now is not None and t - sp["vt"] <= stap * 2.5:
                dm = float(np.mean(np.abs(m_now - sp["vm"])))
                do = float(np.mean(np.abs(o_now - sp["vo"]))) if (o_now is not None and sp["vo"] is not None) else 0.0
                energie = round(max(0.0, dm - 0.6 * do), 3)
            sp["vm"], sp["vo"], sp["vt"] = m_now, o_now, t
            sp["mid"] = 0.8 * sp["mid"] + 0.2 * mid
            sp["xs"].append(mid)
            sp["ws"].append(w / kb)
            sp["ogen"].append((ooghoogte if ooghoogte is not None else y + h * 0.38) / kh)
            sp["tops"].append(y / kh)
            sp["hs"].append(h / kh)
            sp["monsters"].append([round(t, 3), round(mid, 4), energie])
    afgesloten.extend(sporen)
    med = lambda xs: sorted(xs)[len(xs) // 2]
    personen = []
    for sp in afgesloten:
        # Alleen wie een flink deel van zijn camerastandpunt in beeld is en
        # niet piepklein op de achtergrond staat.
        totaal = monsters_per_scene.get(sp["scene"], 1)
        if len(sp["xs"]) < max(2, totaal * 0.3) or med(sp["ws"]) < 0.035:
            continue
        # Een gezicht dat geen millimeter beweegt en waarvan de mond stil is,
        # is geen persoon maar een afbeelding: het portret op een bankbiljet
        # in een graphic, een filmposter aan de muur. Gemeten: x-bereik 0,000
        # en mondbeweging 0 (bankbiljet), 0,001 en 0,04 (poster); de stilste
        # echte luisteraar had 0,006 en 2,9.
        mond = sorted(m[2] for m in sp["monsters"] if m[2] is not None)
        if max(sp["xs"]) - min(sp["xs"]) < 0.006 and (not mond or mond[len(mond) // 2] < 0.2):
            continue
        personen.append({
            "id": 0,
            "scene": sp["scene"],
            "x": round(med(sp["xs"]), 4),
            "breedte": round(med(sp["ws"]), 4),
            "oog": round(med(sp["ogen"]), 4),
            "top": round(med(sp["tops"]), 4),
            "hoogte": round(med(sp["hs"]), 4),
            "n": len(sp["xs"]),
            "monsters": sp["monsters"],
        })
    personen.sort(key=lambda p: (p["scene"], p["x"]))
    for i, p in enumerate(personen):
        p["id"] = i
    return {"van": van, "tot": tot, "stap": stap, "personen": personen, "knippen": knippen}


if SPREKERMODUS:
    opdrachten = json.loads(sys.argv[3])
    print(json.dumps([sprekermeting(float(o["van"]), float(o["tot"]), float(o.get("stap", 0.1))) for o in opdrachten]))
    sys.exit(0)

uit = []
for t in tijden:
    frames = []
    for k in range(MONSTERS):
        # Eén frame per tijdstip: precies op het tijdstip. De spreidingsformule
        # gaf met één monster het begin van het venster (t − 0,5 s), zodat de
        # dichte scan (scenes.ts) elke overgang een halve seconde te vroeg zag.
        moment = float(t) if MONSTERS == 1 else max(0.0, float(t) - SPREIDING + (2 * SPREIDING) * k / max(1, MONSTERS - 1))
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
        # Alle personen, niet alleen de gekozen spreker: de keuring zoekt
        # daarin de actieve spreker op (sprekers.ts), en die hoeft niet de
        # mond te zijn die op deze drie frames toevallig het meest bewoog.
        "gezichten": [
            {
                "x": round(sorted(g["xs"])[len(g["xs"]) // 2], 3),
                "breedte": round(sorted(g["ws"])[len(g["ws"]) // 2], 3),
                "top": round(sorted(g["tops"])[len(g["tops"]) // 2], 3),
                "hoogte": round(sorted(g["hs"])[len(g["hs"]) // 2], 3),
            }
            for g in echt
        ],
    })

print(json.dumps(uit))
