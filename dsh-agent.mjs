#!/usr/bin/env node
/**
 * dsh-agent — quản lý DSH subagent từ CLI.
 *
 * Mô hình: KHÔNG có daemon. Mỗi subagent = 1 session DSH bền (durable) + 1 thư mục
 * trạng thái. Mỗi lần chạy = 1 process `dsh headless` mới:
 *   - lần đầu: session mới (dsh tự sinh id, ta đọc lại từ event `session`)
 *   - các lần sau: `--session-id <cũ>` -> nạp lại log, giữ nguyên ngữ cảnh
 *     (đã đo: prefix KV cache được tái dùng, ~13s/turn)
 *
 * "interrupt" = kill process tree của run đang chạy:
 *   - không kèm prompt  -> dừng hoàn toàn, session vẫn giữ để `send` tiếp
 *   - kèm prompt        -> kill rồi chạy ngay prompt mới trên cùng session,
 *                          nên subagent nhận prompt ngay, không chờ hết turn
 *
 * ponytail: stateless nên không có steer KHÔNG-huỷ (bơm message vào giữa turn mà
 * vẫn giữ bước đang chạy). Cần đúng cái đó thì phải dựng daemon in-process —
 * xem README.md, mục "Nâng cấp".
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SCRIPT = process.argv[1];
const HOME = process.env.DSH_AGENTS_HOME
  || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'agents');
const TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000; // ponytail: trần cứng 3h cho 1 run, đủ rộng, khỏi treo mãi

// ---------------------------------------------------------------- tiện ích

const nowIso = () => new Date().toISOString();
const agentDir = (id) => path.join(HOME, id);
const eventsPath = (id) => path.join(agentDir(id), 'events.ndjson');

function readMeta(id) {
  return JSON.parse(fs.readFileSync(path.join(agentDir(id), 'meta.json'), 'utf8'));
}
function writeMeta(id, meta) {
  const f = path.join(agentDir(id), 'meta.json');
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
function appendEvent(id, obj) {
  fs.appendFileSync(eventsPath(id), `${JSON.stringify(obj)}\n`);
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Trạng thái hiệu dụng: meta.status nhưng tin vào việc process còn sống hay không. */
function statusOf(meta) {
  if (meta.pid && !isAlive(meta.pid)) return meta.status === 'running' ? 'dead' : meta.status;
  return meta.status;
}
function listAgents() {
  if (!fs.existsSync(HOME)) return [];
  return fs.readdirSync(HOME)
    .filter((d) => fs.existsSync(path.join(HOME, d, 'meta.json')))
    .map((d) => { try { return readMeta(d); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * So sánh semver đầy đủ, KHÔNG bỏ qua prerelease:
 * 0.2.0 > 0.2.0-rc.10 > 0.2.0-rc.2 > 0.2.0-alpha.1 > 0.1.9
 * (bản cũ chỉ so 3 số đầu nên 0.2.0 và 0.2.0-rc.5 coi là bằng nhau -> chọn bừa
 * theo thứ tự đọc thư mục; sửa 2026-10-03.)
 */
function cmpVer(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).trim().split('-');
    return { nums: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre === '' ? null : pre.split('.') };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = A.nums[i] ?? 0;
    const y = B.nums[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (A.pre === null || B.pre === null) return A.pre === B.pre ? 0 : (A.pre === null ? 1 : -1);
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i += 1) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y); continue; }
    if (nx !== ny) return nx ? -1 : 1; // số < chữ theo semver
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** Tìm bản `@deepseek-ai/dsh` MỚI NHẤT CÓ TRÊN ĐĨA (không hỏi mạng) để spawn thẳng bằng node. */
function resolveDsh() {
  if (process.env.DSH_BIN) return [process.execPath, [process.env.DSH_BIN]];
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
  ];
  let best = null;
  const consider = (pkg) => {
    const bin = path.join(pkg, 'lib', 'bin.js');
    if (!fs.existsSync(bin)) return;
    let v = '0';
    try { v = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version; } catch { /* giữ 0 */ }
    if (!best || cmpVer(v, best.v) > 0) best = { v, bin };
  };
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    consider(path.join(root, '@deepseek-ai', 'dsh'));
    if (path.basename(root) === '_npx') {
      for (const d of fs.readdirSync(root)) consider(path.join(root, d, 'node_modules', '@deepseek-ai', 'dsh'));
    }
  }
  return best ? [process.execPath, [best.bin]] : null; // null -> fallback `cmd /c dsh`
}

function spawnDsh(cwd, args) {
  const r = resolveDsh();
  const [cmd, pre] = r ?? ['cmd.exe', ['/d', '/c', 'dsh']];
  // Prompt KHÔNG bao giờ nằm trong argv (đi qua stdin) -> argv chỉ có giá trị an toàn.
  return spawn(cmd, [...pre, ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

async function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

// ------------------------------------------------------- runner (nội bộ)

/** Supervisor của 1 run: giữ process dsh, tee NDJSON ra events.ndjson, ghi meta khi xong. */
async function cmdRun(id, prompt) {
  const meta = readMeta(id);
  const runNo = meta.runs.length + 1;
  appendEvent(id, { type: 'run_start', run: runNo, at: nowIso(), prompt });
  const args = ['headless', '--json'];
  if (meta.sessionId) args.push('--session-id', meta.sessionId);
  const child = spawnDsh(meta.cwd, args);

  meta.pid = child.pid;
  meta.status = 'running';
  meta.stopRequested = false;
  meta.runs.push({ n: runNo, startedAt: nowIso(), prompt: prompt.slice(0, 500) });
  writeMeta(id, meta);

  let buf = '';
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    // session id chỉ xuất hiện ở run đầu; ghi lại để các run sau resume đúng session.
    if (ev.type === 'session' && ev.sessionId && readMeta(id).sessionId !== ev.sessionId) {
      const m = readMeta(id);
      m.sessionId = ev.sessionId;
      writeMeta(id, m);
    }
  };
  child.stdout.on('data', (chunk) => {
    fs.appendFileSync(eventsPath(id), chunk);
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const errPath = path.join(agentDir(id), 'stderr.log');
  child.stderr.on('data', (chunk) => fs.appendFileSync(errPath, chunk));
  child.stdin.end(prompt);

  const timer = setTimeout(() => killTree(child.pid), TASK_TIMEOUT_MS);
  child.on('exit', (code) => {
    clearTimeout(timer);
    const m = readMeta(id);
    const killed = m.stopRequested === true;
    appendEvent(id, { type: 'run_end', run: runNo, at: nowIso(), exit: code, killed });
    const rec = m.runs[m.runs.length - 1];
    rec.endedAt = nowIso();
    rec.exit = code;
    m.status = killed ? 'stopped' : (code === 0 ? 'idle' : 'error');
    m.pid = null;
    m.stopRequested = false;
    writeMeta(id, m);
    process.exit(0);
  });
}

// ------------------------------------------------------------ lệnh public

function startRunner(id, prompt) {
  const child = spawn(process.execPath, [SCRIPT, '__run', id], {
    detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], cwd: HOME,
  });
  child.stdin.end(prompt);
  child.unref();
}

/** Chờ đến khi meta thỏa điều kiện (poll nhẹ). */
async function waitFor(id, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = readMeta(id);
    if (pred(meta)) return meta;
    if (Date.now() > deadline) return meta;
    await sleep(300);
  }
}

async function doStop(id, { silent = false } = {}) {
  const meta = readMeta(id);
  if (!meta.pid || !isAlive(meta.pid)) {
    if (!silent) console.log(`${id}: khong co run nao dang chay`);
    return false;
  }
  meta.stopRequested = true; // runner đọc cờ này để ghi 'stopped' thay vì 'error'
  writeMeta(id, meta);
  killTree(meta.pid);
  await waitFor(id, (m) => !m.pid || !isAlive(m.pid), 15000);
  const after = readMeta(id);
  if (after.pid) { after.pid = null; after.status = 'stopped'; writeMeta(id, after); }
  if (!silent) console.log(`${id}: da dung run dang chay (session giu nguyen, gui tiep bang \`send\`)`);
  return true;
}

async function doStart(id, prompt) {
  const before = readMeta(id);
  const runCount = before.runs.length;
  startRunner(id, prompt);
  const meta = await waitFor(id, (m) => m.runs.length > runCount && (m.sessionId || m.status === 'error'), 90000);
  return meta;
}

function argParser(spec) {
  const argv = process.argv.slice(3);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (spec.bool.includes(key)) out[key] = true;
      else if (spec.num.includes(key)) { out[key] = Number(argv[i + 1]); i += 1; }
      else if (spec.str.includes(key)) { out[key] = argv[i + 1]; i += 1; }
      else throw new Error(`unknown option --${key}`);
    } else out._.push(a);
  }
  return out;
}

async function cmdNew(opts) {
  const task = opts._.join(' ');
  if (!task.trim()) throw new Error('thieu task: dsh-agent new "<task>"');
  const cwd = path.resolve(opts.cwd || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`cwd khong ton tai: ${cwd}`);
  const id = `s-${randomBytes(3).toString('hex')}`;
  fs.mkdirSync(agentDir(id), { recursive: true });
  writeMeta(id, {
    id, label: opts.label || task.slice(0, 60), sessionId: null, cwd,
    createdAt: nowIso(), status: 'starting', pid: null, runs: [],
  });
  const meta = await doStart(id, task);
  if (opts.wait) return printWait(id, meta.sessionId);
  console.log(JSON.stringify({ id, sessionId: meta.sessionId, status: statusOf(meta), cwd }, null, 2));
  if (!meta.sessionId) console.error(`canh bao: chua lay duoc session id trong 90s, kiem tra \`dsh-agent status ${id}\``);
}

async function printWait(id, sessionId) {
  if (!sessionId && !readMeta(id).sessionId) { console.log(JSON.stringify(readMeta(id), null, 2)); return; }
  // Chờ runner ghi xong sổ sách (pid=null), không chỉ chờ process chết — nếu không
  // sẽ đọc phải meta cũ và in nhầm status "dead"/exit null.
  const meta = await waitFor(id, (m) => m.pid === null, TASK_TIMEOUT_MS);
  const final = lastFinal(id);
  console.log(JSON.stringify({ id, status: statusOf(meta), exit: meta.runs.at(-1)?.exit ?? null }, null, 2));
  if (final) console.log(final);
  return meta;
}

async function cmdSend(opts) {
  const [id, ...rest] = opts._;
  const msg = rest.join(' ');
  if (!id || !msg.trim()) throw new Error('dung: dsh-agent send <id> "<message>"');
  const meta = readMeta(id);
  if (meta.pid && isAlive(meta.pid)) {
    console.error(`${id}: dang chay -> interrupt (huy run hien tai) roi gui prompt moi ngay`);
    await doStop(id, { silent: true });
  }
  const after = await doStart(id, msg);
  if (opts.wait) return printWait(id, after.sessionId);
  console.log(JSON.stringify({ id, status: statusOf(after), sessionId: after.sessionId, run: after.runs.length }, null, 2));
}

async function cmdInterrupt(opts) {
  const [id, ...rest] = opts._;
  if (!id) throw new Error('dung: dsh-agent interrupt <id> ["<prompt moi>"]');
  const msg = rest.join(' ');
  const stopped = await doStop(id);
  if (!msg.trim()) return undefined;
  console.error(`${id}: gui prompt moi ngay sau interrupt`);
  const after = await doStart(id, msg);
  if (opts.wait) return printWait(id, after.sessionId);
  console.log(JSON.stringify({ id, status: statusOf(after), sessionId: after.sessionId, run: after.runs.length, stopped }, null, 2));
  return undefined;
}

function lastFinal(id) {
  const lines = fs.readFileSync(eventsPath(id), 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    try { const ev = JSON.parse(lines[i]); if (ev.type === 'final') return ev.text; } catch { /* bỏ dòng hỏng */ }
  }
  return '';
}

const clip = (s, n) => {
  const one = String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** Một dòng text cho mỗi event; limit/offset đếm theo EVENT (không phải theo dòng vật lý). */
function renderEvent(ev, verbose) {
  const t = new Date(ev.at || Date.now()).toLocaleTimeString('vi-VN', { hour12: false });
  switch (ev.type) {
    case 'run_start': return `── run ${ev.run} · ${t} · "${clip(ev.prompt, 160)}"`;
    case 'run_end': return `── run ${ev.run} ket thuc · exit=${ev.exit}${ev.killed ? ' (bi interrupt)' : ''}`;
    case 'text': return `assistant: ${clip(ev.text, 400)}`;
    case 'final': return `final: ${ev.text}`;
    case 'tool_call': return `tool: ${ev.tool}(${clip(JSON.stringify(ev.input), 300)})`;
    case 'tool_result': return `  ↳ ${ev.status}: ${clip(ev.result, 300)}`;
    case 'error': return `error: ${ev.message}`;
    case 'thinking': return verbose ? `thinking: ${clip(ev.text, 300)}` : null;
    case 'status': return verbose ? `status: ${ev.phase}${ev.turn ? ` turn=${ev.turn}` : ''}${ev.step ? ` step=${ev.step}` : ''}` : null;
    default: return verbose ? JSON.stringify(ev) : null;
  }
}

function cmdHistory(opts) {
  const [id] = opts._;
  if (!id) throw new Error('dung: dsh-agent history <id> [--limit N] [--offset M] [--raw] [--all]');
  const raw = fs.readFileSync(eventsPath(id), 'utf8').split('\n').filter((l) => l.trim());
  const events = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const verbose = opts.all === true;
  const rows = opts.raw
    ? events.map((e) => JSON.stringify(e))
    : events.map((e) => renderEvent(e, verbose)).filter((r) => r !== null);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
  // offset đếm NGƯỢC từ mới nhất: offset=0 là cửa sổ mới nhất, offset=30 là trang trước đó.
  const end = Math.max(0, rows.length - offset);
  const start = Math.max(0, end - limit);
  const window = rows.slice(start, end);
  const meta = readMeta(id);
  console.log(`# ${id} · ${statusOf(meta)} · ${rows.length} muc · hien ${window.length} muc [${start}..${end}) · session ${meta.sessionId ?? '?'}`);
  console.log(window.join('\n'));
}

function cmdList(opts) {
  const all = listAgents();
  const rows = opts.all ? all : all.filter((m) => statusOf(m) !== 'stopped');
  if (!rows.length) { console.log('(chua co subagent nao)'); return; }
  for (const m of rows) {
    const last = m.runs.at(-1);
    console.log(`${m.id}  ${statusOf(m).padEnd(9)} runs=${String(m.runs.length).padEnd(3)} ${(last?.startedAt ?? m.createdAt).slice(0, 19)}  ${m.label ?? ''}`);
  }
}

function cmdStatus(opts) {
  const [id] = opts._;
  if (!id) return cmdList({ _: [], all: opts.all });
  const m = readMeta(id);
  console.log(JSON.stringify({
    id: m.id, status: statusOf(m), sessionId: m.sessionId, cwd: m.cwd,
    runs: m.runs.map((r) => ({ n: r.n, startedAt: r.startedAt, endedAt: r.endedAt ?? null, exit: r.exit ?? null })),
  }, null, 2));
  return undefined;
}

// ------------------------------------------------------------- self-check

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };
  assert(cmpVer('0.2.0', '0.1.9') > 0, 'cmpVer');
  assert(cmpVer('0.2.0', '0.2.0-rc.2') > 0, 'release > prerelease');
  assert(cmpVer('0.2.0-rc.10', '0.2.0-rc.2') > 0, 'prerelease so sanh theo so');
  assert(cmpVer('0.1.7-rc.2', '0.1.7-alpha.2') > 0, 'rc > alpha');
  assert(cmpVer('0.2.0-rc.2', '0.2.0-rc.2') === 0, 'cmpVer bang nhau');
  assert(clip('a\n\n  b', 50) === 'a ⏎ b', `clip -> ${clip('a\n\n  b', 50)}`);
  const rows = Array.from({ length: 10 }, (_, i) => `l${i}`);
  const win = (limit, offset) => {
    const end = Math.max(0, rows.length - offset);
    return rows.slice(Math.max(0, end - limit), end);
  };
  assert(win(3, 0).join() === 'l7,l8,l9', `window moi nhat -> ${win(3, 0)}`);
  assert(win(3, 3).join() === 'l4,l5,l6', `window trang truoc -> ${win(3, 3)}`);
  assert(win(30, 50).join() === '', 'offset vuot qua do dai');
  const dsh = resolveDsh();
  assert(dsh === null || fs.existsSync(dsh[1][0]), 'resolveDsh tra ve file that');
  const tmpId = `s-self${randomBytes(2).toString('hex')}`;
  fs.mkdirSync(agentDir(tmpId), { recursive: true });
  writeMeta(tmpId, { id: tmpId, runs: [], sessionId: null, status: 'idle', pid: null, createdAt: nowIso() });
  appendEvent(tmpId, { type: 'text', text: 'hello' });
  assert(readMeta(tmpId).runs.length === 0 && lastFinal(tmpId) === '', 'meta roundtrip + lastFinal rong');
  fs.rmSync(agentDir(tmpId), { recursive: true, force: true });
  console.log(`selftest OK · dsh=${dsh ? dsh[1][0] : 'cmd /c dsh (fallback)'}`);
}

// ------------------------------------------------------------------ main

/**
 * Đường WEB: điều khiển thẳng web host đang chạy (GUI của bạn) qua HTTP API.
 * Ưu điểm so với đường headless: agent sống trong RAM (nhanh), `steer` được thật
 * (mode=steer -> agent.steer, không bỏ bước đang chạy), `stop` = cancel sạch sẽ
 * (giữ hàng đợi), và mọi subagent HIỆN TRONG GUI để bạn xem/can thiệp bằng tay.
 */
async function webMain(cmd, opts, web) {
  const id = opts._[0];
  const msg = opts._.slice(1).join(' ');
  // id kieu `s-xxxxxx` = subagent duong headless (khong phai session cua GUI):
  // van dung CLI nay duoc, chi la di duong cu.
  if (id && !['new', 'list', 'selftest', 'host'].includes(cmd) && fs.existsSync(path.join(agentDir(id), 'meta.json'))) {
    return headlessMain(cmd, opts);
  }
  switch (cmd) {
    case 'new': {
      const task = opts._.join(' ');
      if (!task.trim()) throw new Error('thieu task: dsh-agent new "<task>"');
      const cwd = path.resolve(opts.cwd || process.cwd());
      if (!fs.existsSync(cwd)) throw new Error(`cwd khong ton tai: ${cwd}`);
      const { sessionId } = await web.create(cwd);
      web.remember(sessionId, { label: opts.label || task.slice(0, 60), cwd, kind: 'web' });
      await web.prompt(sessionId, task, 'queue');
      if (opts.wait) return webWait(sessionId, web);
      console.log(JSON.stringify({ id: sessionId, sessionId, status: 'running', cwd, transport: 'web' }, null, 2));
      return undefined;
    }
    case 'send': {
      if (!id || !msg.trim()) throw new Error('dung: dsh-agent send <id> "<message>"');
      const mode = opts.steer === true ? 'steer' : 'queue';
      const r = await web.prompt(id, msg, mode);
      if (opts.wait) return webWait(id, web);
      console.log(JSON.stringify({ id, accepted: r?.accepted ?? true, mode, transport: 'web' }, null, 2));
      return undefined;
    }
    case 'steer': {
      if (!id || !msg.trim()) throw new Error('dung: dsh-agent steer <id> "<message>"');
      const r = await web.prompt(id, msg, 'steer');
      console.log(JSON.stringify({ id, accepted: r?.accepted ?? true, mode: 'steer', transport: 'web' }, null, 2));
      return undefined;
    }
    case 'interrupt': {
      if (!id) throw new Error('dung: dsh-agent interrupt <id> ["<prompt moi>"]');
      const stopped = await web.cancel(id);
      if (msg.trim()) await web.prompt(id, msg, 'queue');
      if (opts.wait) return webWait(id, web);
      console.log(JSON.stringify({ id, stopped: stopped?.accepted ?? true, resent: Boolean(msg.trim()), transport: 'web' }, null, 2));
      return undefined;
    }
    case 'stop': {
      if (!id) throw new Error('dung: dsh-agent stop <id>');
      const r = await web.cancel(id);
      if (opts.wait) return webWait(id, web);
      console.log(JSON.stringify({ id, stopped: r?.accepted ?? true, transport: 'web' }, null, 2));
      return undefined;
    }
    case 'history': {
      if (!id) throw new Error('dung: dsh-agent history <id> [--limit N] [--offset M] [--all]');
      const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
      const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
      const { records, hasMore } = await web.readPage(id, limit + offset);
      const rows = opts.raw
        ? records.map((r) => JSON.stringify(r))
        : records.map((r) => web.renderRecord(r, opts.all === true)).filter((r) => r !== null);
      const end = Math.max(0, rows.length - offset);
      const start = Math.max(0, end - limit);
      const win = rows.slice(start, end);
      const s = await web.one(id);
      console.log(`# ${id} · ${s?.running ? 'running' : 'idle'} · hien ${win.length}/${rows.length} muc [${start}..${end}) · con trang truoc: ${hasMore}`);
      console.log(win.join('\n'));
      return undefined;
    }
    case 'list': {
      const live = await web.list();
      const byId = new Map(live.map((s) => [s.sessionId, s]));
      const webRows = web.entries().map((e) => ({
        id: e.sessionId,
        label: e.label,
        status: byId.get(e.sessionId)?.running ? 'running' : (byId.has(e.sessionId) ? 'idle' : 'gone'),
        transport: 'web',
      }));
      const headRows = listAgents().map((m) => ({ id: m.id, label: m.label, status: statusOf(m), transport: 'headless' }));
      const rows = opts.all
        ? [
          ...live.map((s) => ({ id: s.sessionId, label: s.projections?.values?.title ?? '', status: s.running ? 'running' : 'idle', transport: 'web' })),
          ...headRows,
        ]
        : [...webRows, ...headRows];
      if (!rows.length) { console.log('(chua co subagent nao do tool tao; dung --all de xem moi session trong GUI)'); return undefined; }
      for (const r of rows) {
        console.log(`${r.id}  ${r.status.padEnd(8)} ${r.transport.padEnd(9)} ${String(r.label ?? '').slice(0, 70)}`);
      }
      console.log(`(${rows.length} subagent · ${webRows.length} web + ${headRows.length} headless · ${live.filter((s) => s.running).length} session dang chay trong GUI)`);
      return undefined;
    }
    case 'rm': case 'archive': {
      if (!id) throw new Error('dung: dsh-agent rm <id>');
      const r = await web.archive(id);
      const idx = web.entries();
      if (idx.some((e) => e.sessionId === id)) web.forget(id);
      console.log(JSON.stringify({ id, archived: true, archivedTotal: r?.archivedSessionIds?.length, transport: 'web' }, null, 2));
      return undefined;
    }
    case 'unarchive': {
      if (!id) throw new Error('dung: dsh-agent unarchive <id>');
      const r = await web.unarchive(id);
      console.log(JSON.stringify({ id, archived: false, archivedTotal: r?.archivedSessionIds?.length, transport: 'web' }, null, 2));
      return undefined;
    }
    case 'status': {
      if (!id) return webMain('list', { _: [], all: opts.all }, web);
      const s = await web.one(id);
      if (!s) throw new Error(`khong thay session ${id}`);
      console.log(JSON.stringify({
        id, transport: 'web', status: s.running ? 'running' : 'idle', cwd: s.cwd,
        agentInRam: s.agentAvailable === true, title: s.projections?.values?.title ?? null,
        turns: (s.projections?.values?.turnOutline ?? []).length, updatedAt: new Date(s.updatedAt).toISOString(),
      }, null, 2));
      return undefined;
    }
    case 'host': {
      // host [status|start|stop] — quản lý tiến trình web host mà tool tự dựng
      const sub = opts._[0] ?? 'status';
      if (sub === 'stop') { console.log(JSON.stringify(web.stopOwnHost(), null, 2)); return undefined; }
      const rt = await web.ready();
      const info = { base: rt.base, started: rt.started === true };
      console.log(JSON.stringify(sub === 'start' ? info : { ...info, ...(await web.hostInfo().catch(() => ({}))) }, null, 2));
      return undefined;
    }
    case 'selftest': return webSelftest(web);
    default: throw new Error(`lenh la khong biet: ${cmd}\n\n${USAGE}`);
  }
}

async function webWait(sessionId, web) {
  // Prompt vừa được xếp hàng: chờ tới khi CÓ event mới VÀ session đã ngừng chạy.
  // (Chỉ hỏi `running` là sai: ngay sau khi gửi, turn chưa kịp bật -> tưởng đã xong.)
  const before = (await web.one(sessionId))?.projections?.asOfSeq ?? -1;
  const deadline = Date.now() + 3 * 60 * 60 * 1000;
  let idle = true;
  for (;;) {
    const s = await web.one(sessionId);
    if ((s?.projections?.asOfSeq ?? -1) > before && s?.running !== true) {
      await new Promise((r) => setTimeout(r, 1500)); // nhịp đệm: model có thể vào turn ngay sau đó
      if (!(await web.isRunning(sessionId))) break;
    }
    if (Date.now() > deadline) { idle = false; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const answer = await web.lastAnswer(sessionId);
  console.log(JSON.stringify({ id: sessionId, status: idle ? 'idle' : 'timeout', transport: 'web' }, null, 2));
  if (answer) console.log(answer);
  return undefined;
}

function webSelftest(web) {
  const assert = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); };
  const rec = (type, data) => ({ type, seq: 1, time: Date.now(), data });
  assert(web.renderRecord(rec('tool/call', { name: 'pwsh', arguments: '{"command":"ls"}' })) === 'tool: pwsh({"command":"ls"})', 'render tool/call');
  assert(web.renderRecord(rec('user/message', { content: [{ type: 'text', text: 'Current runtime context. blah' }] })) === null, 'bo message he thong');
  assert(web.renderRecord(rec('user/message', { content: [{ type: 'text', text: 'xin chao' }] })) === 'nguoi: xin chao', 'render user');
  assert(web.renderRecord(rec('assistant/message', { message: { content: [{ type: 'text', text: 'chao ban' }] } })) === 'assistant: chao ban', 'render assistant');
  assert(web.renderRecord(rec('step/end', {})) === null, 'bo step/end khi khong --all');
  assert(
    web.answerFrom([{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ket qua' }] } } } }]) === 'ket qua',
    'answerFrom boc duoc {event} (bug cu: --wait khong in cau tra loi)',
  );
  console.log('selftest web OK');
}

const USAGE = `dsh-agent — quan ly DSH subagent

  Mac dinh: KHONG can ban bat gi ca. Tool tu tim web host theo 3 nac: (1) cookie da
  luu (song 30 ngay, qua ca restart GUI), (2) token trong .web-token / $DSH_WEB_TOKEN,
  (3) tu khoi dong host rieng va tu bat token tu stdout cua no. Khong nac nao duoc thi
  roi ve duong HEADLESS. Ep bang --web / --headless.

  new "<task>" [--cwd DIR] [--label L] [--wait]
      Tao subagent moi (chay nen, tra ve id ngay). --wait: doi xong va in ket qua.
  send <id> "<message>" [--steer] [--wait]
      Gui tiep, GIU NGUYEN ngu canh. Mac dinh xep hang cho het turn dang chay;
      --steer: chen vao turn dang chay (khong bo buoc dang lam).
  steer <id> "<message>"
      Nhu send --steer, dung khi ban muon doi huong giua chung.
  interrupt <id> ["<prompt moi>"]
      Dung turn dang chay NGAY (web: cancel sach se). Kem prompt -> chay prompt moi ngay.
  stop <id>
      Dung hoan toan (session van giu, send lai duoc).
  rm <id> | unarchive <id>
      An subagent khoi danh sach (co che Archive cua GUI; khoi phuc duoc bang
      unarchive hoac menu "All conversations" trong GUI). DSH khong xoa cung.
  history <id> [--limit N] [--offset M] [--raw] [--all]
      Lich su lam viec. offset dem NGUOC tu moi nhat (offset=30 -> trang truoc).
  list [--all] | status <id> | host [status|start|stop] | selftest
`;

async function main() {
  const cmd = process.argv[2];
  if (cmd === '__run') return cmdRun(process.argv[3], fs.readFileSync(0, 'utf8'));
  if (!cmd || cmd === 'help' || cmd === '--help') { process.stdout.write(USAGE); return undefined; }
  const opts = argParser({
    bool: ['wait', 'raw', 'all', 'web', 'headless', 'steer'],
    num: ['limit', 'offset'],
    str: ['cwd', 'label'],
  });

  // selftest chay ca 2 tang: phan thuan (headless) + phan render cua web
  if (cmd === 'selftest') {
    const web = await import('./dsh-web.mjs');
    web.configure({ dshBin: resolveDsh()[1][0] });
    selftest();
    if (await web.up({ autoStart: false })) webSelftest(web);
    else console.log('(chua co web host -> bo qua selftest web)');
    return undefined;
  }

  // Chon duong: uu tien web host (tu khoi dong neu chua co), khong duoc thi headless.
  const web = await import('./dsh-web.mjs');
  web.configure({ dshBin: resolveDsh()[1][0] });
  const forced = opts.web === true;
  const useWeb = opts.headless !== true && (forced || await web.up());
  if (useWeb) {
    try {
      return await webMain(cmd, opts, web);
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      throw new Error(`${m}\n(neu web host vua tat, chay lai voi --headless de di duong cu)`);
    }
  }
  if (forced) throw new Error(`--web nhung khong ket noi duoc web host (${process.env.DSH_WEB_BASE || 'http://127.0.0.1:3080'})`);

  return headlessMain(cmd, opts);
}
/** Đường HEADLESS cũ: mỗi lượt 1 process `dsh headless`, interrupt = kill process tree. */
async function headlessMain(cmd, opts) {
  switch (cmd) {
    case 'new': return cmdNew(opts);
    case 'send': return cmdSend(opts);
    case 'steer':
      throw new Error('steer can web host dang chay (duong headless khong co steer khong-huy). Mo GUI roi thu lai, hoac dung `send` / `interrupt`.');
    case 'interrupt': return cmdInterrupt(opts);
    case 'stop': {
      const [id] = opts._;
      if (!id) throw new Error('dung: dsh-agent stop <id>');
      await doStop(id);
      return undefined;
    }
    case 'history': return cmdHistory(opts);
    case 'list': return cmdList(opts);
    case 'status': return cmdStatus(opts);
    case 'selftest': return selftest();
    default: throw new Error(`lenh la khong biet: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(`dsh-agent: ${err instanceof Error ? err.message : String(err)}`);
  // exitCode thay vì exit(): de undici dong socket sach se, tranh assertion libuv tren Windows
  process.exitCode = 1;
});
