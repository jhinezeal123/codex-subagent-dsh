import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./dsh-agent.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-live-'));
const run = promisify(execFile);
const cli = async (...args) => (await run(process.execPath, [CLI, ...args, '--headless'], {
  env: { ...process.env, DSH_AGENTS_HOME: home }, windowsHide: true, timeout: 240000,
})).stdout;
const meta = (id) => JSON.parse(fs.readFileSync(path.join(home, id, 'meta.json'), 'utf8'));
const created = [];
try {
  const first = await cli('new', 'Do not call tools. Remember HEADLESS-928614 and reply only that code.', '--wait');
  const id = /"id":\s*"([^"]+)"/.exec(first)?.[1];
  assert.ok(id, 'new --wait returns an agent id');
  created.push(id);
  assert.match(first, /"status": "idle"/);
  assert.match(first, /"exit": 0/);
  assert.match(first, /\nHEADLESS-928614\s*$/);
  const sessionId = meta(id).sessionId;
  const followup = await cli('send', id, 'Do not call tools. Reply only the HEADLESS code from my first message.', '--wait');
  assert.match(followup, /\nHEADLESS-928614\s*$/);
  assert.equal(meta(id).sessionId, sessionId);
  assert.equal(meta(id).runs.length, 2);
  console.log('PASS: headless new --wait completes and followup preserves session and memory');

  await cli('send', id, 'Run pwsh: Start-Sleep -Seconds 300 . Then reply SLEEP-DONE.');
  const deadline = Date.now() + 120000;
  let toolStarted = false;
  while (Date.now() < deadline) {
    const records = fs.readFileSync(path.join(home, id, 'events.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    toolStarted = records.some((record) => record.type === 'tool_call');
    if (toolStarted) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(toolStarted, 'sleep tool starts before interruption');
  const interrupted = await cli('interrupt', id, 'Do not call tools. Reply only HEADLESS-INTERRUPT-OK.', '--wait');
  assert.match(interrupted, /\nHEADLESS-INTERRUPT-OK\s*$/);
  assert.equal(meta(id).sessionId, sessionId);
  assert.equal(meta(id).status, 'idle');
  assert.ok(meta(id).runs[2].exit !== 0, 'interrupted process did not complete normally');
  console.log('PASS: headless interrupt kills the executing tool and resumes the same session');
} finally {
  for (const id of created) await cli('stop', id);
  const web = await import('./dsh-web.mjs');
  for (const id of created) if (meta(id).sessionId) await web.archive(meta(id).sessionId);
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(home, { recursive: true, force: true });
}
