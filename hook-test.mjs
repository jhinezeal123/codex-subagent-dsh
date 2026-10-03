#!/usr/bin/env node
/**
 * hook-test.mjs — kiểm kênh ngược (hook UserPromptSubmit) bằng tay, không cần Codex.
 *
 *  1. Không có báo cáo -> hook in RỖNG (không bơm rác vào context).
 *  2. Giao việc cho 1 subagent, đợi nó xong (dùng `reports --peek`, KHÔNG tiêu thụ).
 *  3. Chạy hook với payload stdin giả đúng schema Codex
 *     (user-prompt-submit.command.input) -> phải in JSON hợp lệ với
 *     hookSpecificOutput.additionalContext chứa envelope native.
 *  4. Chạy hook lần hai -> rỗng (đã tiêu thụ: báo cáo chỉ giao MỘT lần).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(file, args, stdin = '') {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(DIR, file), ...args], { cwd: DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(stdin);
  });
}

const PAYLOAD = JSON.stringify({
  cwd: DIR,
  hook_event_name: 'UserPromptSubmit',
  model: 'gpt-5-codex',
  permission_mode: 'default',
  prompt: 'tiep tuc di',
  session_id: 'session-gia-lap',
  transcript_path: null,
  turn_id: 'turn-1',
});

const hook = () => run('hook-reports.mjs', [], PAYLOAD);

const empty = await hook();
assert(empty.out.trim() === '', `khong co bao cao -> stdout phai rong, nhan duoc: ${empty.out.slice(0, 200)}`);
assert(empty.code === 0, `hook phai exit 0, nhan duoc ${empty.code}`);
console.log('1 OK · không có báo cáo -> hook im lặng, exit 0');

const spawned = await run('dsh-agent.mjs', ['new', 'Tra loi dung mot tu duy nhat: DELTA', '--label', 'hook-test']);
const id = JSON.parse(spawned.out).id;
console.log(`   (subagent ${id} dang chay)`);
try {
  let seen = false;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const r = await run('dsh-agent.mjs', ['reports', '--json', '--peek']);
    if (/DELTA/i.test(r.out)) { seen = true; break; }
    await sleep(3000);
  }
  assert(seen, 'subagent phai xong va co bao cao trong hang doi (peek)');

  const fired = await hook();
  const parsed = JSON.parse(fired.out);
  assert(parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit', `hook phai tra hookEventName dung, nhan duoc: ${fired.out.slice(0, 200)}`);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert(/^Message Type: FINAL_ANSWER/m.test(ctx), `additionalContext phai la envelope native, nhan duoc: ${String(ctx).slice(0, 200)}`);
  assert(/DELTA/i.test(ctx), 'envelope phai chua cau tra loi that');
  assert(ctx.includes('Task name: hook-test'), 'envelope phai dung label');
  console.log(`3 OK · hook bơm envelope vào context (${ctx.length} ký tự)`);

  const second = await hook();
  assert(second.out.trim() === '', `bao cao chi giao MOT lan, lan hai phai rong, nhan duoc: ${second.out.slice(0, 200)}`);
  console.log('4 OK · báo cáo chỉ giao một lần (không lặp lại mỗi turn)');
} finally {
  const r = await run('dsh-agent.mjs', ['rm', id]);
  console.log(`don dep ${id}: exit=${r.code}`);
}
console.log('HOOK OK');
