#!/usr/bin/env python3
"""Staat er op deze momenten een mens in het eindbeeld?

Gebruik: eindbeeld.py <mp4> '<json-lijst van tijden>'
Uitvoer: json-lijst per tijd: true (mens in beeld), false (niemand), "links" of
"rechts" (het grootste gezicht raakt die beeldrand: het hoofd is afgesneden), of
null als het frame niet te lezen was.

De randmeting is geijkt op vier renders: in drie goede clips (378 momenten)
raakt geen enkel gezichtsvak de rand; in de Koen-clip met een half hoofd in
beeld 11 van de 160.

Bewust los van gezichten.py: daar wordt op de bron gemeten, waar gezichten
klein zijn. In het eindbeeld (1080x1920) vult een gezicht tot de helft van de
breedte, en op die schaal mist YuNet de helft. Gemeten op de ambulanceclip:
op 1080 breed 9 van 21 momenten gevonden, op 360 breed 20 van 21, en de lege
frames (speakerkast) blijven op elke schaal leeg. Daarom: verkleinen, en een
moment telt als "mens" zodra een van beide schalen een gezicht vindt.
"""
import json
import os
import sys

import cv2

MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "modellen", "face_detection_yunet_2023mar.onnx")
BREEDTES = (360, 270)
DREMPEL = 0.4

pad = sys.argv[1]
tijden = json.loads(sys.argv[2])
det = cv2.FaceDetectorYN.create(MODEL, "", (320, 320), DREMPEL, 0.3, 5000)
cap = cv2.VideoCapture(pad)
uit = []
for t in tijden:
    cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000)
    ok, frame = cap.read()
    if not ok or frame is None:
        uit.append(None)
        continue
    gevonden = False
    for breed in BREEDTES:
        s = breed / frame.shape[1]
        klein = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        det.setInputSize((klein.shape[1], klein.shape[0]))
        _, r = det.detect(klein)
        if r is not None and len(r):
            gevonden = True
            # Het grootste gezicht: raakt zijn vak de linker- of rechterrand?
            x, _y, w, _h = [float(v) for v in max(r, key=lambda q: q[2] * q[3])[:4]]
            b = klein.shape[1]
            if x < 0.01 * b:
                gevonden = "links"
            elif x + w > 0.99 * b:
                gevonden = "rechts"
            break
    uit.append(gevonden)
print(json.dumps(uit))
