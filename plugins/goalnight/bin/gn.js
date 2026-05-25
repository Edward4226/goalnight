#!/usr/bin/env node
/**
 * `gn` CLI — minimal shell wrapper around goalnight tools.
 *
 * v0.1 scope:
 *   gn                      Print the goalnight boot banner + help
 *   gn <Nh> "<objective>"   Print the @goalnight invocation to paste into codex
 *   gn status               Print current session status (JSON)
 *   gn brief                Print morning brief (markdown)
 *   gn dashboard            Open localhost dashboard
 *
 * Most heavy lifting goes through the MCP tools the model calls.
 * This CLI is for the user, not the agent.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI ────────────────────────────────────────────────────────
// Honor NO_COLOR env var (https://no-color.org) + TTY-only color.
const useColor =
  !process.env.NO_COLOR &&
  process.stdout.isTTY &&
  (process.env.TERM || '') !== 'dumb';

const c = useColor
  ? {
      amb:   '\x1b[38;5;214m', // amber — matches --moon-yellow #F5B23E
      sec:   '\x1b[38;5;245m', // secondary text
      mut:   '\x1b[38;5;240m', // muted
      dim:   '\x1b[38;5;238m', // dim
      reset: '\x1b[0m',
    }
  : { amb: '', sec: '', mut: '', dim: '', reset: '' };

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── banner — C.2 mini, the ascii owl as a sign-off ─────────────
//   Eyes are the brand (see Hoot the mascot). Owl shows up once,
//   as a handoff. 5 lines · 80-col safe.
function printBanner() {
  const v = readVersion();
  const port = process.env.GOALNIGHT_PORT || '8888';
  const { amb, sec, mut, dim, reset } = c;
  // Each line: owl glyph slice + meta text on the right.
  process.stdout.write(`
${amb}    ___    ___${reset}
${amb}   /(o)\\__/(o)\\${reset}      ${sec}goalnight${reset} ${mut}v${v}${reset}
${amb}   \\  ${reset}\\${dim}--${reset}/${amb}  /${reset}        the overnight shift for your codex
${amb}    \\_${reset}${dim}/<>${reset}\\${amb}_/${reset}         dashboard ${sec}http://localhost:${port}${reset}
${dim}      ^^${reset}

`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // Bare `gn` — the discoverable moment. Banner + help.
  if (!cmd) {
    printBanner();
    return printHelp();
  }

  if (cmd === '-h' || cmd === '--help') return printHelp();
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
    console.log(readVersion());
    return;
  }

  switch (cmd) {
    case 'status': {
      const { status } = await import('../server/tools/status.js');
      console.log(JSON.stringify(await status({}), null, 2));
      return;
    }
    case 'brief': {
      const { morningBrief } = await import('../server/tools/morning_brief.js');
      const b = await morningBrief({});
      console.log(b.markdown);
      return;
    }
    case 'dashboard': {
      const port = process.env.GOALNIGHT_PORT || '8888';
      const url = `http://localhost:${port}`;
      const opener =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      console.log(`Opened ${url}`);
      return;
    }
    default: {
      // Shorthand: `gn 8h "objective"` → print the @goalnight line for codex.
      const hoursMatch = /^(\d+)h$/i.exec(cmd);
      if (hoursMatch) {
        const hours = parseInt(hoursMatch[1], 10);
        const objective = args.slice(1).join(' ').trim();
        if (!objective) {
          console.error('Usage: gn <Nh> "<objective>"');
          process.exit(1);
        }
        console.log(`\nOpen codex and say:\n\n  @goalnight plan ${hours}h to ${objective}\n\nOr paste the line above into your active codex session.\n`);
        return;
      }
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
    }
  }
}

function printHelp() {
  console.log(`Usage:
  gn                    Show this banner + help
  gn <Nh> "<goal>"      Print the @goalnight invocation to paste into codex
  gn status             Print current session status (JSON)
  gn brief              Print morning brief (markdown)
  gn dashboard          Open the cozy dashboard in your browser
  gn version            Print version
  gn --help             Print help without the banner

Inside an active codex session:
  @goalnight plan 8h to <goal>
  @goalnight brief

NO_COLOR=1 to disable colored output.
`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
