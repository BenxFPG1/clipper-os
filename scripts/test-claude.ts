/**
 * Test voor de Claude Code-backend (src/lib/claude.ts): een grote
 * systeemprompt mag nooit meer als argument op de commandline (E2BIG — Linux
 * staat hoogstens 128 KB per argument toe). Draait tegen een stub-CLI, dus
 * zonder netwerk of abonnement; de database blijft buiten schot.
 *
 * Draaien: npm run test:claude
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// Geen verbruikslog naar de database vanuit een test.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

let gefaald = 0;
let gedaan = 0;
function toets(naam: string, voorwaarde: boolean, detail = '') {
  gedaan++;
  if (voorwaarde) console.log(`  ✓ ${naam}`);
  else {
    gefaald++;
    console.log(`  ✗ ${naam}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const map = mkdtempSync(join(tmpdir(), 'clipper-test-claude-'));
  try {
    // Stub: kent --system-prompt-file (in --help), meldt wat hij binnenkreeg.
    const stub = join(map, 'claude-stub');
    const verslag = join(map, 'verslag.json');
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('  --system-prompt-file <file>  System prompt from file'); process.exit(0); }
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const i = args.indexOf('--system-prompt-file');
  const j = args.indexOf('--system-prompt');
  const systeem = i >= 0 ? fs.readFileSync(args[i + 1], 'utf8') : j >= 0 ? args[j + 1] : '';
  const argBytes = args.reduce((t, a) => t + Buffer.byteLength(a), 0);
  fs.writeFileSync(${JSON.stringify(verslag)}, JSON.stringify({ viaBestand: i >= 0, bestand: i >= 0 ? args[i + 1] : null, systeemBytes: Buffer.byteLength(systeem), argBytes, stdinBytes: Buffer.byteLength(stdin) }));
  console.log(JSON.stringify({ result: JSON.stringify({ ok: true, lengte: systeem.length }), total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
    );
    chmodSync(stub, 0o755);
    process.env.CLAUDE_BACKEND = 'claude-code';
    process.env.CLAUDE_CLI_BIN = stub;

    const { structuredCall, systeemPromptVoorCli, SYSTEEM_ARG_MAX } = await import('../src/lib/claude');

    console.log('grote systeemprompt');
    // 1,5 MB: boven Linux' 128 KB per argument én boven macOS' ARG_MAX (1 MB).
    const groot = 'Regel voor de edit-agent. '.repeat(60_000);
    const schema = z.object({ ok: z.boolean(), lengte: z.number() });
    let fout: string | null = null;
    let uit: z.infer<typeof schema> | null = null;
    try {
      uit = await structuredCall({ system: groot, user: 'maak het plan', schema, toolName: 't', toolDescription: 'test', operation: 'test' });
    } catch (e) {
      fout = (e as Error).message;
    }
    const v = JSON.parse(readFileSync(verslag, 'utf8')) as { viaBestand: boolean; bestand: string; systeemBytes: number; argBytes: number };
    toets('geen E2BIG: de call slaagt', fout === null && uit?.ok === true, fout ?? '');
    toets('systeemprompt via --system-prompt-file, volledig', v.viaBestand && v.systeemBytes === Buffer.byteLength(groot), JSON.stringify(v));
    toets('commandline blijft klein', v.argBytes < 4096, String(v.argBytes));
    let opgeruimd = false;
    try {
      readFileSync(v.bestand);
    } catch {
      opgeruimd = true;
    }
    toets('tijdelijk bestand opgeruimd', opgeruimd);

    // Ter controle dat de test iets bewijst: dezelfde prompt als argument
    // haalt de CLI niet eens.
    const oud = await new Promise<string>((klaar) => {
      try {
        const c = spawn(stub, ['-p', '--system-prompt', groot]);
        c.on('error', (e: NodeJS.ErrnoException) => klaar(e.code ?? e.message));
        c.on('close', (code) => klaar(`exit ${code}`));
        c.stdin.on('error', () => undefined);
        c.stdin.end('x');
      } catch (e) {
        klaar((e as NodeJS.ErrnoException).code ?? (e as Error).message);
      }
    });
    toets('controle: als argument geeft dezelfde prompt E2BIG', oud === 'E2BIG', oud);

    console.log('kleine systeemprompt');
    await structuredCall({ system: 'kort', user: 'x', schema, toolName: 't', toolDescription: 'test', operation: 'test' });
    const v2 = JSON.parse(readFileSync(verslag, 'utf8')) as { viaBestand: boolean; systeemBytes: number };
    toets('klein blijft gewoon --system-prompt', !v2.viaBestand && v2.systeemBytes === 4, JSON.stringify(v2));

    console.log('CLI zonder --system-prompt-file');
    const zonder = systeemPromptVoorCli(groot, 'de vraag', { kentBestand: false });
    toets('systeemprompt bovenaan stdin met scheiding', zonder.prompt.startsWith('=== SYSTEEMINSTRUCTIES ===\n') && zonder.prompt.includes('=== EINDE SYSTEEMINSTRUCTIES ===\n\nde vraag'));
    toets('en een korte verwijzing als argument', zonder.args.every((a) => Buffer.byteLength(a) < SYSTEEM_ARG_MAX) && zonder.args[0] === '--system-prompt');
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
  console.log(`\n${gedaan - gefaald}/${gedaan} geslaagd`);
  if (gefaald > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
