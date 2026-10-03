#!/usr/bin/env node
/**
 * mcp-test.mjs â€” live eval cho táº§ng MCP sau khi Ä‘á»•i sang bá»™ tool native-parity.
 *
 * Kiá»ƒm 6 Ä‘iá»u:
 *  1. tools/list Ä‘Ãºng 7 tool, Ä‘Ãºng tÃªn native-parity.
 *  2. initialize cÃ³ `instructions` (router cho model).
 *  3. spawn -> wait tráº£ envelope Ä‘Ãºng format native + cÃ¢u tráº£ lá»i tháº­t.
 *  4. wait Ä‘Ã£ Ä‘Ã¡nh dáº¥u Ä‘Ã£ Ä‘á»c -> reports_only tráº£ Rá»–NG (khÃ´ng bÃ¡o láº·p).
 *  5. reports_only (mark_read:false) tháº¥y bÃ¡o cÃ¡o Má»šI mÃ  khÃ´ng cáº§n gá»i wait
 *     => Ä‘Ã¢y chÃ­nh lÃ  Ä‘Æ°á»ng hook UserPromptSubmit dÃ¹ng.
 *  6. reports_only máº·c Ä‘á»‹nh thÃ¬ tiÃªu thá»¥ bÃ¡o cÃ¡o (gá»i láº§n 2 pháº£i rá»—ng).
 *
 * ÄÃ¢y lÃ  live eval (cÃ³ gá»i model tháº­t) nÃªn cháº­m; khÃ´ng pháº£i unit test.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(DIR, 'dsh-agent.mjs');
const MCP = path.join(DIR, 'dsh-agent-mcp.mjs');

const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

function startServer() {
  const srv = spawn(process.execPath, [MCP], {
    cwd: DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_MCP_PROGRESS_MS: '500' }, // hạ nhịp progress để test nhanh
  });
  const waiters = new Map();
  const notes = [];
  let buf = '';
  let id = 0;
  srv.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      else if (m.method) notes.push(m);
    }
  });
  const rpc = (method, params, timeoutMs = 400000) => new Promise((resolve, reject) => {
    const myId = ++id;
    const timer = setTimeout(() => { waiters.delete(myId); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    waiters.set(myId, (m) => { clearTimeout(timer); if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`)); else resolve(m.result); });
    srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  return { srv, rpc, notes };
}

const textOf = (res) => (res?.content ?? []).map((c) => c.text).join('\n');

const EXPECTED = [
  'dsh_subagent_spawn', 'dsh_subagent_followup', 'dsh_subagent_message',
  'dsh_subagent_wait', 'dsh_subagent_interrupt', 'dsh_subagent_list', 'dsh_subagent_history',
];

const created = [];
try {
  const { srv, rpc, notes } = startServer();

  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1' } });
  assert(typeof init?.instructions === 'string' && init.instructions.includes('dsh_subagent_spawn'), 'initialize phai co instructions');
  const list = await rpc('tools/list', {});
  const names = list.tools.map((t) => t.name);
  assert(JSON.stringify(names) === JSON.stringify(EXPECTED), `7 tool dung ten native-parity, nhan duoc: ${names.join(',')}`);
  assert(list.tools.every((t) => /NOT for|NOT a/.test(t.description)), 'moi description phai co menh de NOT ...');
  console.log(`1-2 OK Â· ${names.length} tool, co instructions`);

  // 3. spawn + wait -> envelope native
  const spawnRes = await rpc('tools/call', { name: 'dsh_subagent_spawn', arguments: { task: 'Tra loi dung mot tu, duy nhat: PONG', name: 'mcp-test-A' } });
  const spawned = JSON.parse(textOf(spawnRes));
  created.push(spawned.id);
  assert(spawned.id && spawned.status === 'running', `spawn tra id + running, nhan duoc: ${textOf(spawnRes).slice(0, 200)}`);
  const waitRes = await rpc('tools/call', { name: 'dsh_subagent_wait', arguments: { ids: [spawned.id], timeout_ms: 180000 } });
  const wt = textOf(waitRes);
  assert(/^Message Type: FINAL_ANSWER/m.test(wt), `wait phai tra envelope native, nhan duoc: ${wt.slice(0, 200)}`);
  assert(wt.includes('Task name: mcp-test-A'), 'Task name phai la name luc spawn');
  assert(wt.includes(`Sender: ${spawned.id}`), 'Sender phai la id');
  assert(/PONG/i.test(wt), `envelope phai chua cau tra loi that, nhan duoc: ${wt.slice(0, 300)}`);
  assert(waitRes.isError !== true, 'wait thanh cong khong duoc la isError');
  console.log(`3 OK Â· wait tra envelope dung format (${wt.split('\n').length} dong)`);

  // 4. da doc roi -> khong bao lai
  const drain1 = await rpc('tools/call', { name: 'dsh_subagent_list', arguments: { reports_only: true } });
  assert((drain1.content ?? []).length === 0, `wait da tieu thu bao cao -> reports_only phai rong, nhan duoc: ${textOf(drain1).slice(0, 200)}`);
  console.log('4 OK Â· wait Ä‘Ã£ Ä‘Ã¡nh dáº¥u Ä‘Ã£ Ä‘á»c, khÃ´ng bÃ¡o láº·p');

  // 5. bao cao moi tu den ma khong can wait (duong hook)
  const spawn2 = await rpc('tools/call', { name: 'dsh_subagent_spawn', arguments: { task: 'Tra loi dung mot tu, duy nhat: BETA', name: 'mcp-test-B' } });
  const id2 = JSON.parse(textOf(spawn2)).id;
  created.push(id2);
  let hookText = '';
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const peek = await rpc('tools/call', { name: 'dsh_subagent_list', arguments: { reports_only: true, mark_read: false } });
    hookText = textOf(peek);
    if (/BETA/i.test(hookText)) break;
    await sleep(3000);
  }
  assert(/BETA/i.test(hookText), `reports_only (peek) phai thay bao cao moi khong can wait, nhan duoc: ${hookText.slice(0, 200)}`);
  assert(hookText.includes('Task name: mcp-test-B'), 'bao cao phai dung Task name cua agent B');
  // peek khong duoc tieu thu
  const peekAgain = await rpc('tools/call', { name: 'dsh_subagent_list', arguments: { reports_only: true, mark_read: false } });
  assert(/BETA/i.test(textOf(peekAgain)), 'mark_read:false khong duoc tieu thu bao cao');
  console.log('5 OK Â· Ä‘Æ°á»ng hook: bÃ¡o cÃ¡o tá»± tá»›i, peek khÃ´ng tiÃªu thá»¥');

  // 6. mac dinh = tieu thu
  const drain2 = await rpc('tools/call', { name: 'dsh_subagent_list', arguments: { reports_only: true } });
  assert(/BETA/i.test(textOf(drain2)), 'lan doc dau phai tra bao cao');
  const drain3 = await rpc('tools/call', { name: 'dsh_subagent_list', arguments: { reports_only: true } });
  assert((drain3.content ?? []).length === 0, 'lan doc thu hai phai rong (da tieu thu)');
  console.log('6 OK Â· reports_only máº·c Ä‘á»‹nh tiÃªu thá»¥ bÃ¡o cÃ¡o');

  // 7. progress + "khong co gi moi" (khong duoc coi la loi)
  const noOne = await rpc('tools/call', {
    name: 'dsh_subagent_wait',
    arguments: { ids: ['session-khong-ton-tai'], timeout_ms: 12000 },
    _meta: { progressToken: 'tok-1' },
  });
  assert(noOne.isError !== true, 'wait khong co ket qua KHONG duoc la isError');
  const prog = notes.filter((n) => n.method === 'notifications/progress');
  assert(prog.length >= 1, `phai phat notifications/progress khi chay lau, nhan duoc ${prog.length}`);
  assert(/khong co bao cao moi/i.test(textOf(noOne)), `ket cuc nothing-new phai noi ro, nhan duoc: ${textOf(noOne).slice(0, 120)}`);
  console.log(`7 OK · ${prog.length} progress phat ra, ket cuc nothing-new khong phai loi`);

  // 8. interrupt mode=agent (native: close_agent) tra ve duoc, khong crash
  const spawn3 = await rpc('tools/call', {
    name: 'dsh_subagent_spawn',
    arguments: { task: 'Chay lenh: Start-Sleep -Seconds 20 . Sau do tra loi dung mot tu: GAMMA', name: 'mcp-test-C' },
  });
  const id3 = JSON.parse(textOf(spawn3)).id;
  created.push(id3);
  const stopped = await rpc('tools/call', { name: 'dsh_subagent_interrupt', arguments: { id: id3, mode: 'agent' } });
  assert(!/unknown tool/i.test(textOf(stopped)), 'interrupt phai la tool that');
  assert(stopped.isError !== true, `interrupt mode=agent phai chay duoc, nhan duoc: ${textOf(stopped).slice(0, 200)}`);
  console.log(`8 OK · interrupt mode=agent: ${textOf(stopped).replace(/\s+/g, ' ').slice(0, 90)}`);

  const progressNote = notes.filter((n) => n.method === 'notifications/progress').length;
  console.log(`(ghi chu: ${notes.length} notification tu server, ${progressNote} progress)`);
  srv.stdin.end();
  srv.kill();
} finally {
  for (const id of created) {
    const r = await runCli(['rm', id]);
    console.log(`don dep ${id}: exit=${r.code} ${r.out.trim().slice(0, 120)}`);
  }
}
console.log('MCP OK');
