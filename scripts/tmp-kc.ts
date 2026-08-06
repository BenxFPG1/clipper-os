import { corrigeerKadrering, uitsnedeVan, gezichtPast } from '../src/lib/roughcut/kadercontrole';
const shots: any[] = [
  { volgorde: 5, start: 3683.24, end: 3692.79, functie: 'button', focusX: 0.599, focusW: 0.123,
    paneel: [0.5727, 1.0], zoom: 1.7,
    gezicht: { x: 0.599, breedte: 0.123, top: 0.2, hoogte: 0.282 } },
];
console.log('correcties:', corrigeerKadrering(shots));
const s: any = shots[0];
console.log('paneel:', s.paneel, 'zoom', (s.zoom ?? 1).toFixed(2), 'focusX', s.focusX.toFixed(3), 'focusY', s.focusY?.toFixed(2));
