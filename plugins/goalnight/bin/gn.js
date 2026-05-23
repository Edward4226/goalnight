#!/usr/bin/env node
/**
 * `gn` CLI — minimal shell wrapper around goalnight tools.
 *
 * v0.1 scope:
 *   gn <Nh> "<objective>"   Print the @goalnight invocation to paste into codex
 *   gn status               Print current session status (JSON)
 *   gn brief                Print morning brief (markdown)
 *   gn dashboard            Open localhost dashboard
 *
 * Most heavy lifting goes through the MCP tools the model calls.
 * This CLI is for the user, not the agent.
 */

import { spawn } from 'node:child_process';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '-h' || cmd === '--help') return printHelp();

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
  console.log(`gn — goalnight CLI

Usage:
  gn <Nh> "<goal>"      Print the @goalnight invocation to paste into codex
  gn status             Print current session status (JSON)
  gn brief              Print morning brief (markdown)
  gn dashboard          Open the cozy dashboard in your browser

Inside an active codex session:
  @goalnight plan 8h to <goal>
  @goalnight brief
`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
