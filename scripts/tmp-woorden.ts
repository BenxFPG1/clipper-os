import 'dotenv/config';
import { haalBronWoorden } from '../src/lib/roughcut/woorden';
async function main() {
  const B = '/var/folders/l9/_j1slgfs3f3d3x4y6m7jcs5m0000gn/T//clipper-bron/a48414d1-cb86-4d88-9769-ebd22f80a096/bron.mp4';
  const w = await haalBronWoorden('a48414d1-cb86-4d88-9769-ebd22f80a096', B, { log: (m) => console.log(m) });
  console.log('woorden:', w?.length ?? 0);
}
main();
