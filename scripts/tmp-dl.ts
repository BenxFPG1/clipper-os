import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { db } from '../src/lib/supabase';
async function main() {
  const s = db();
  const { data } = await s.from('render_jobs').select('bestanden').eq('id','b3bbc4a9-e8f2-4413-a399-a74cc191998b').single();
  const b = (data!.bestanden as { naam: string; pad: string }[])[0];
  const dl = await s.storage.from('montages').download(b.pad);
  const doel = '/private/tmp/claude-501/-Users-antonie-Documents-Antonie-Cursor-Clipping-tool/f990e09c-89da-49bd-984c-7161a83ac7f5/scratchpad/testclip4.mp4';
  await writeFile(doel, Buffer.from(await dl.data!.arrayBuffer()));
  console.log(doel);
}
main();
