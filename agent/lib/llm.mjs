// One question to Claude, one structured answer back.
// Runs the Claude Code CLI with every tool switched off. It signs in with either
// ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, whichever the environment provides.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 5 * 60 * 1000;

function runClaude(args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited with ${code}: ${(err || out).slice(0, 400)}`));
    });
    child.stdin.end(input);
  });
}

export async function ask({ system, prompt, schema, model }) {
  // An empty working folder, so no project settings or instructions leak into the call.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tracker-llm-'));
  try {
    const systemFile = path.join(dir, 'system.md');
    await writeFile(systemFile, system);
    const out = await runClaude([
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--system-prompt-file', systemFile,
      '--model', model,
      '--tools', '',
      '--disallowedTools', 'mcp__*',
      '--strict-mcp-config',
      '--no-session-persistence',
    ], prompt, dir);
    const result = JSON.parse(out);
    if (result.is_error || !result.structured_output) {
      throw new Error(`no structured answer: ${String(result.result ?? result.subtype).slice(0, 300)}`);
    }
    return { data: result.structured_output, cost: result.total_cost_usd ?? 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
