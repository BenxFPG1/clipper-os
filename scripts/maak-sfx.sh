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

# impact — de klap onder het moment dat de aanname breekt.
ffmpeg -y -v error \
  -f lavfi -i "sine=frequency=62:duration=0.7:sample_rate=48000" \
  -f lavfi -i "anoisesrc=d=0.09:c=white:a=0.7:r=48000" \
  -filter_complex "[0:a]volume=0.9,afade=t=out:st=0.03:d=0.62:curve=exp[laag];[1:a]highpass=f=1200,volume=0.35,afade=t=out:st=0:d=0.09[tik];[laag][tik]amix=inputs=2:duration=longest:normalize=0,volume=1.2" \
  -ac 1 "$map/impact.wav"

# bass_drop — dezelfde klap maar dieper en langer, onder een visuele payoff.
ffmpeg -y -v error -f lavfi -i "sine=frequency=48:duration=1.2:sample_rate=48000" \
  -af "volume=1.0,afade=t=in:st=0:d=0.01,afade=t=out:st=0.1:d=1.1:curve=exp,lowpass=f=140" \
  -ac 1 "$map/bass_drop.wav"

# sub_boom — korte lage klap onder een tekstkaart die binnenkomt.
ffmpeg -y -v error -f lavfi -i "sine=frequency=54:duration=0.55:sample_rate=48000" \
  -af "volume=0.95,afade=t=out:st=0.02:d=0.53:curve=exp,lowpass=f=170" \
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

# Alles op hetzelfde piekniveau zetten (-4 dBFS). Anders is de ene tik
# onhoorbaar onder de spraak en knalt de andere eroverheen; de montage regelt
# alleen nog de gemeenschappelijke mixverhouding.
for f in "$map"/*.wav; do
  piek=$(ffmpeg -i "$f" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')
  winst=$(python3 -c "print(round(-4 - ($piek), 2))")
  ffmpeg -y -v error -i "$f" -af "volume=${winst}dB" "${f%.wav}-n.wav"
  mv "${f%.wav}-n.wav" "$f"
done
echo "genormaliseerd op -4 dBFS piek"
