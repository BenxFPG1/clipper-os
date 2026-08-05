#!/usr/bin/env bash
# Bouwt de muziekbedden uit assets/muziek opnieuw op.
#
# Dit zijn bewust sobere bedden: een lage drone met een puls, geen melodie. Dat
# is precies wat de editcraft-vault voorschrijft (een bed mag de aandacht niet
# stelen van wat er gezegd wordt) én het is de enige soort muziek die je
# rechtenvrij kunt synthetiseren zonder dat het als goedkope stockmuziek klinkt.
#
# Wil je echte productiemuziek: zet je eigen gelicenseerde bestand als
# assets/muziek/<slug>.mp3 neer — die wint automatisch van deze.
set -euo pipefail
cd "$(dirname "$0")/.."
map=assets/muziek
mkdir -p "$map"
DUUR=90

# spanningsbed — lage drone met een trage puls. Draagt spanning zonder melodie.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=55:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "sine=frequency=82.5:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "anoisesrc=d=$DUUR:c=brown:a=0.35:r=48000" \
  -filter_complex "[0:a]volume=0.5[a];[1:a]volume=0.18[b];[2:a]lowpass=f=220,volume=0.3[c];[a][b][c]amix=inputs=3:normalize=0,tremolo=f=0.7:d=0.35,lowpass=f=600,volume=0.5" \
  -ac 2 -b:a 128k "$map/spanningsbed.mp3"

# opbouw — hetzelfde idee maar stijgend: de puls wordt sneller en het filter
# opent. Bedoeld om weg te vallen op de payoff (dat regelt de montage).
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=55:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "sine=frequency=110:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "anoisesrc=d=$DUUR:c=pink:a=0.3:r=48000" \
  -filter_complex "[0:a]volume=0.45[a];[1:a]volume=0.2[b];[2:a]bandpass=f=900:width_type=q:w=0.8,volume=0.25[c];[a][b][c]amix=inputs=3:normalize=0,tremolo=f=2.2:d=0.45,lowpass=f=1400,volume=0.5" \
  -ac 2 -b:a 128k "$map/opbouw.mp3"

# luchtig — hogere, zachtere puls voor comedy en lichte content.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=220:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "sine=frequency=330:duration=$DUUR:sample_rate=48000" \
  -f lavfi -i "sine=frequency=110:duration=$DUUR:sample_rate=48000" \
  -filter_complex "[0:a]volume=0.16[a];[1:a]volume=0.1[b];[2:a]volume=0.3[c];[a][b][c]amix=inputs=3:normalize=0,tremolo=f=3.4:d=0.6,lowpass=f=2200,volume=0.45" \
  -ac 2 -b:a 128k "$map/luchtig.mp3"

# Bedden op een vast, laag niveau: de montage duckt ze daarna nog eens onder de
# spraak, dus ze mogen hier al bescheiden staan.
for f in "$map"/*.mp3; do
  piek=$(ffmpeg -i "$f" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')
  winst=$(python3 -c "print(round(-14 - ($piek), 2))")
  ffmpeg -y -v error -i "$f" -af "volume=${winst}dB" -b:a 128k "${f%.mp3}-n.mp3"
  mv "${f%.mp3}-n.mp3" "$f"
done

echo "muziekbedden gebouwd (-14 dBFS piek):"
ls -la "$map"/*.mp3
