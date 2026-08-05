#!/usr/bin/env bash
# Bouwt de geluidseffecten uit assets/sfx opnieuw op.
#
# Waarom gesynthetiseerd en niet gedownload: sample-pakketten hebben licenties
# die per gebruik verschillen, en clips gaan naar platforms die daarop
# controleren. Deze effecten zijn met ffmpeg uit ruis en sinussen opgebouwd —
# er zit dus niets in wat van iemand anders is.
#
# De slugs komen exact overeen met de effectenvault; ontbreekt een bestand, dan
# slaat de montage dat effect stil over.
set -euo pipefail
cd "$(dirname "$0")/.."
map=assets/sfx
mkdir -p "$map"

# whoosh — ruis die van laag naar hoog veegt: markeert een sprong of wissel.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=0.55:c=pink:a=0.9:r=48000" \
  -af "asendcmd='0.0 highpass frequency 200;0.1 highpass frequency 700;0.2 highpass frequency 1600;0.3 highpass frequency 3000;0.4 highpass frequency 5000',highpass=f=200,volume=0.55,afade=t=in:st=0:d=0.06,afade=t=out:st=0.3:d=0.25" \
  -ac 1 "$map/whoosh.wav"

# riser — spanning opbouwen naar een onthulling; stopt hard op het antwoord.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=1.6:c=white:a=0.8:r=48000" \
  -af "asendcmd='0.0 bandpass frequency 300;0.4 bandpass frequency 900;0.8 bandpass frequency 1800;1.2 bandpass frequency 3200;1.45 bandpass frequency 5200',bandpass=f=300:width_type=q:w=1.2,volume=0.5,afade=t=in:st=0:d=1.2:curve=exp,afade=t=out:st=1.5:d=0.1" \
  -ac 1 "$map/riser.wav"

# impact — de klap onder het moment dat de aanname breekt. Bewust niet één
# lage sinus: dat klinkt precies als een microfoon die verschoven wordt. Een
# korte aanslag in de midden plus een strak uitdempende bodem leest wél als een
# gemaakt effect.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=95:duration=0.35:sample_rate=48000" \
  -f lavfi -i "sine=frequency=190:duration=0.25:sample_rate=48000" \
  -f lavfi -i "anoisesrc=d=0.07:c=white:a=0.7:r=48000" \
  -filter_complex "[0:a]volume=0.8,afade=t=out:st=0.01:d=0.34:curve=exp[laag];[1:a]volume=0.3,afade=t=out:st=0:d=0.25:curve=exp[mid];[2:a]bandpass=f=2200:width_type=q:w=1.2,volume=0.4,afade=t=out:st=0:d=0.07[tik];[laag][mid][tik]amix=inputs=3:duration=longest:normalize=0,highpass=f=70" \
  -ac 1 "$map/impact.wav"

# bass_drop — dieper en langer, onder een visuele payoff. Met een dalende toon
# in plaats van een vaste: dat hoor je als een bewuste drop en niet als stoten.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=1.0:c=brown:a=0.8:r=48000" \
  -af "asendcmd='0.0 lowpass frequency 400;0.2 lowpass frequency 240;0.5 lowpass frequency 150;0.8 lowpass frequency 90',lowpass=f=400,volume=0.9,afade=t=in:st=0:d=0.02,afade=t=out:st=0.15:d=0.85:curve=exp,highpass=f=45" \
  -ac 1 "$map/bass_drop.wav"

# sub_boom — korte klap onder een tekstkaart die binnenkomt.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=88:duration=0.4:sample_rate=48000" \
  -f lavfi -i "anoisesrc=d=0.05:c=white:a=0.6:r=48000" \
  -filter_complex "[0:a]volume=0.8,afade=t=out:st=0.01:d=0.39:curve=exp[laag];[1:a]bandpass=f=1800:width_type=q:w=1.2,volume=0.3[tik];[laag][tik]amix=inputs=2:duration=longest:normalize=0,highpass=f=65" \
  -ac 1 "$map/sub_boom.wav"

# ding — bevestigt een goed antwoord of een punt; grondtoon plus kwint.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=1760:duration=0.8:sample_rate=48000" \
  -f lavfi -i "sine=frequency=2637:duration=0.8:sample_rate=48000" \
  -filter_complex "[0:a]volume=0.5[a];[1:a]volume=0.25[b];[a][b]amix=inputs=2:normalize=0,afade=t=out:st=0.05:d=0.75:curve=exp" \
  -ac 1 "$map/ding.wav"

# klok_tik — één droge tik onder een wachtmoment of aftelling.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=0.05:c=white:a=0.9:r=48000" \
  -af "bandpass=f=2400:width_type=q:w=2,volume=0.6,afade=t=out:st=0:d=0.05:curve=exp" \
  -ac 1 "$map/klok_tik.wav"

# typemachine — aanslag onder tekst die letter voor letter verschijnt.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=0.04:c=white:a=0.8:r=48000" \
  -af "bandpass=f=1500:width_type=q:w=1.5,volume=0.45,afade=t=out:st=0:d=0.04:curve=exp" \
  -ac 1 "$map/typemachine.wav"

# record_scratch — patroonbreuk in comedy: ruis die snel omlaag zakt.
ffmpeg -y -v error -f lavfi -i "anoisesrc=d=0.45:c=brown:a=0.9:r=48000" \
  -af "asendcmd='0.0 bandpass frequency 3000;0.12 bandpass frequency 1600;0.24 bandpass frequency 800;0.36 bandpass frequency 350',bandpass=f=3000:width_type=q:w=1.4,volume=0.7,afade=t=out:st=0.3:d=0.15" \
  -ac 1 "$map/record_scratch.wav"

echo "sfx opnieuw gebouwd:"
ls -la "$map" | tail -n +2

# Alles op hetzelfde piekniveau zetten (-14 dBFS). Eerder stond dit op -4, en
# met de mixfactor erbij kwamen de effecten harder binnen dan de stem: dat hoor
# je niet als sound design maar als iemand die tegen de microfoon stoot.
for f in "$map"/*.wav; do
  piek=$(ffmpeg -i "$f" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')
  winst=$(python3 -c "print(round(-14 - ($piek), 2))")
  ffmpeg -y -v error -i "$f" -af "volume=${winst}dB" "${f%.wav}-n.wav"
  mv "${f%.wav}-n.wav" "$f"
done
echo "genormaliseerd op -14 dBFS piek"
