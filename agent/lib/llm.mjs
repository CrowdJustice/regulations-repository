// One question to Claude, one structured answer back.
// Runs the Claude Code CLI with every tool switched off. It signs in with either
// ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, whichever the environment provides.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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
    // If the CLI exits before reading its input, the write fails. The "close" handler above reports it.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Tests set TRACKER_AI_STUB to a file of ready-made answers, so a run can be rehearsed with no AI:
// { "writer": { "<item url>": answer }, "checker": { "<record id>": answer } }. A checker answer that is missing passes.
async function rehearsed({ prompt, schema }) {
  const stub = JSON.parse(await readFile(process.env.TRACKER_AI_STUB, 'utf8'));
  if (schema.properties.decision) {
    const url = prompt.match(/^url: (\S+)$/m)?.[1];
    if (!stub.writer?.[url]) throw new Error(`no rehearsed answer for ${url}`);
    return { data: structuredClone(stub.writer[url]), cost: 0 };
  }
  const id = prompt.match(/"id": "([^"]+)"/)?.[1];
  return { data: stub.checker?.[id] ?? { pass: true, problems: [], duplicate_of: null }, cost: 0 };
}

export async function ask({ system, prompt, schema, model }) {
  if (process.env.TRACKER_AI_STUB) return rehearsed({ prompt, schema });
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
