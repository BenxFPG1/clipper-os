import { corrigeerKadrering, maakControlebeelden } from '../src/lib/roughcut/kadercontrole';

const B = '/var/folders/l9/_j1slgfs3f3d3x4y6m7jcs5m0000gn/T//clipper-bron/a48414d1-cb86-4d88-9769-ebd22f80a096/bron.mp4';
const SC = '/private/tmp/claude-501/-Users-antonie-Documents-Antonie-Cursor-Clipping-tool/f990e09c-89da-49bd-984c-7161a83ac7f5/scratchpad';

async function main() {
  const shots: any[] = [
    { volgorde: 5, start: 3683.24, end: 3692.79, functie: 'button', focusX: 0.599, focusW: 0.123,
      zoom: 1.7, gezicht: { x: 0.599, breedte: 0.123, top: 0.2, hoogte: 0.282 } },
  ];
  console.log('correcties:', corrigeerKadrering(shots));
  console.log('zoom', shots[0].zoom.toFixed(2), 'focusX', shots[0].focusX.toFixed(3), 'focusY', shots[0].focusY.toFixed(2));
  await maakControlebeelden(B, shots, SC, 'vullend');
}
main();
