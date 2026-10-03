import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('report delivery and authentication regressions (isolated host)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-report-test-'));
  const fixtures = new Map();
  let deniedCalls = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const frame = JSON.parse(body);
    if (frame.method === 'test/denied') {
      deniedCalls += 1;
      res.writeHead(401).end();
      return;
    }
    const id = frame.payload.args.request.address.sessionId;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { ok: true, value: { records: fixtures.get(id) ?? [] } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    DSH_WEB_BASE: base,
    DSH_AGENTS_HOME: dir,
    DSH_WEB_COOKIE_FILE: path.join(dir, 'cookie.json'),
    DSH_WEB_STATE_FILE: path.join(dir, 'state.json'),
    DSH_WEB_TOKEN_FILE: path.join(dir, 'token'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.writeFileSync(env.DSH_WEB_COOKIE_FILE, JSON.stringify({ [base.replace('http://', '')]: 'dsh-auth-test=fixture' }));
  const event = (type, seq, data = {}) => ({ event: { type, seq, data } });
  const answer = (seq, text) => event('assistant/message', seq, { message: { content: [{ type: 'text', text }] } });
  const hook = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./hook-reports.mjs', import.meta.url))], { env: { ...process.env }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err)));
    child.stdin.end('{}');
  });
  try {
    const web = await import('./dsh-web.mjs');
    for (let i = 1; i <= 5; i++) {
      const id = `agent-${i}`;
      web.remember(id, { label: id });
      fixtures.set(id, [answer(1, `ANSWER-${i}`), event('turn/end', 2, { turn: 1 })]);
    }
    const first = JSON.parse(await hook()).hookSpecificOutput.additionalContext;
    assert.equal((first.match(/Message Type: FINAL_ANSWER/g) ?? []).length, 3);
    const unread = await web.reports({ markRead: false });
    assert.deepEqual(unread.map((row) => row.id), ['agent-4', 'agent-5']);
    const second = JSON.parse(await hook()).hookSpecificOutput.additionalContext;
    assert.match(second, /ANSWER-4/);
    assert.match(second, /ANSWER-5/);
    assert.equal(await hook(), '');
    console.log('PASS: hook delivers 3 + 2 reports without loss or repetition');

    web.remember('turns', {});
    fixtures.set('turns', [answer(1, 'COMPLETED'), event('turn/end', 2, { turn: 1 }), answer(3, 'IN PROGRESS')]);
    assert.equal((await web.reports({ ids: ['turns'] }))[0].answer, 'COMPLETED');
    fixtures.set('turns', [answer(1, 'COMPLETED'), event('turn/end', 2, { turn: 1 }), event('turn/end', 4, { turn: 2, reason: { kind: 'cancelled' } })]);
    assert.equal((await web.reports({ ids: ['turns'] }))[0].answer, '');
    console.log('PASS: completed reports exclude running and older turn answers');

    await assert.rejects(web.call('test/denied'), /HTTP 401.*after retry/);
    assert.equal(deniedCalls, 2);
    console.log('PASS: authentication retries exactly once');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
