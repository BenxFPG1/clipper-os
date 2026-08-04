"""Gezichtsposities per tijdstip, voor het kadreren van verticale uitsnedes.

Aanroep: python3 gezichten.py <video> '[12.5, 40.2, ...]'
Uitvoer: JSON-lijst met per tijdstip de horizontale positie (0..1) van het
grootste gezicht, of null als er geen gezicht gevonden is.
"""
import sys, json

try:
    import cv2
except ImportError:
    print("[]")
    sys.exit(0)

pad = sys.argv[1]
tijden = json.loads(sys.argv[2])
cap = cv2.VideoCapture(pad)
haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

uit = []
for t in tijden:
    cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000)
    ok, frame = cap.read()
    if not ok:
        uit.append(None)
        continue
    grijs = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gezichten = haar.detectMultiScale(grijs, 1.2, 5, minSize=(60, 60))
    if len(gezichten) == 0:
        uit.append(None)
        continue
    x, y, w, h = max(gezichten, key=lambda r: r[2] * r[3])
    uit.append(round((x + w / 2) / frame.shape[1], 3))

print(json.dumps(uit))
