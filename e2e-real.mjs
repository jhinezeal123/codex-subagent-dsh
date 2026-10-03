#!/usr/bin/env node
/**
 * e2e-real.mjs Ã¢â‚¬â€ E2E THÃ¡ÂºÂ¬T: Codex thÃ¡ÂºÂ­t (CODEX_HOME tÃ¡ÂºÂ¡m, khÃƒÂ´ng Ã„â€˜Ã¡Â»Â¥ng ~/.codex cÃ¡Â»Â§a bÃ¡ÂºÂ¡n)
 *   turn 1: Codex gÃ¡Â»Âi MCP tool cÃ¡Â»Â§a ta -> tÃ¡ÂºÂ¡o subagent DSH thÃ¡ÂºÂ­t
 *   (chÃ¡Â»Â subagent xong, dÃƒÂ¹ng `reports --peek` nÃƒÂªn KHÃƒâ€NG tiÃƒÂªu thÃ¡Â»Â¥ bÃƒÂ¡o cÃƒÂ¡o)
 *   turn 2: resume -> hook UserPromptSubmit phÃ¡ÂºÂ£i bÃ†Â¡m envelope vÃƒÂ o context
 *
 * ChÃ¡Â»Â©ng minh 2 Ã„â€˜iÃ¡Â»Âu mÃƒÂ  test nÃ¡Â»â„¢i bÃ¡Â»â„¢ khÃƒÂ´ng chÃ¡Â»Â©ng minh Ã„â€˜Ã†Â°Ã¡Â»Â£c: Codex thÃ¡ÂºÂ­t cÃƒÂ³ gÃ¡Â»Âi Ã„â€˜Ã†Â°Ã¡Â»Â£c
 * MCP server cÃ¡Â»Â§a ta, vÃƒÂ  hook cÃƒÂ³ thÃ¡ÂºÂ­t sÃ¡Â»Â± inject vÃƒÂ o model.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(REPO, 'dsh-agent.mjs');
const E2E = path.join(os.tmpdir(), 'codex-e2e-dsh');
const WORK = path.join(os.tmpdir(), 'codex-e2e-work');
const CODEX = 'C:\\Users\\DELL\\AppData\\Local\\OpenAI\\Codex\\bin\\a51e250fa15c740a\\codex.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ dÃ¡Â»Â±ng nhÃƒÂ  tÃ¡ÂºÂ¡m
fs.rmSync(E2E, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(E2E, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(E2E, 'auth.json'));
fs.writeFileSync(path.join(E2E, 'config.toml'), [
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[mcp_servers.dsh-agent]',
  "command = 'C:\\Program Files\\nodejs\\node.exe'",
  `args = ['${path.join(REPO, 'dsh-agent-mcp.mjs')}']`,
  'startup_timeout_sec = 60',
  'tool_timeout_sec = 900',
  'default_tools_approval_mode = "approve"',
  '',
].join('\n'));
fs.writeFileSync(path.join(E2E, 'hooks.json'), JSON.stringify({
  description: 'e2e: dsh-agent reverse channel',
  hooks: {
    UserPromptSubmit: [{
      matcher: null,
      hooks: [{
        type: 'command',
        command: `node "${path.join(REPO, 'hook-reports.mjs')}"`,
        commandWindows: `node "${path.join(REPO, 'hook-reports.mjs')}"`,
        timeoutSec: 3,
        additionalContextLimit: 0,
      }],
    }],
  },
}, null, 2));
console.log(`CODEX_HOME tam: ${E2E}`);

const env = { ...process.env, CODEX_HOME: E2E };
// cwd = WORK (resume KHONG nhan -C), va phai co --skip-git-repo-check vi WORK khong
// phai git repo (Codex tu choi chay trong thu muc khong tin cay).
const runCodex = (args, input) => spawnSync(CODEX, args, { input, env, encoding: 'utf8', cwd: WORK, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });

// ------------------------------------------------------------------ turn 1
console.log('\n### TURN 1: Codex that goi MCP tool cua ta');
const t1 = runCodex(['exec', '-', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust'],
  'Goi MCP tool dsh_subagent_spawn voi name=\'e2e-hook\' va task=\'Chay lenh sau bang pwsh: node -e "console.log(String(Math.floor(Math.random()*900000)+100000))" . Roi tra loi DUY NHAT con so do, khong giai thich.\'. Sau khi co id thi KET THUC turn ngay: khong cho ket qua, khong goi tool nao khac.');
const o1 = `${t1.stdout ?? ''}${t1.stderr ?? ''}`;
const calledMcp = /dsh_subagent_spawn/.test(o1) && /mcp_tool_call|dsh-agent/.test(o1);
const sid = (o1.match(/session-[0-9a-f-]{36}/) ?? [null])[0];
console.log(calledMcp ? `Codex DA goi MCP tool cua ta Ã¢Å“â€œ (session ${sid})` : `Codex KHONG goi duoc MCP tool Ã¢Å“â€”`);
if (!calledMcp) console.log(o1.slice(-2500));

// ------------------------------------------------------------------ chÃ¡Â»Â subagent xong
console.log('\n### cho subagent xong (peek)');
let reportSeen = false;
for (let i = 0; i < 60; i += 1) {
  const r = runCli(['reports', '--json', '--peek']);
  if (/"answer":\s*"\d{6}"/.test(r.stdout ?? '') || /\b\d{6}\b/.test(r.stdout ?? '')) { reportSeen = true; console.log(`co bao cao so ngau nhien sau ~${i * 3}s`); break; }
  await sleep(3000);
}
if (!reportSeen) console.log('KHONG thay bao cao so ngau nhien trong hang doi');

// ------------------------------------------------------------------ turn 2
console.log('\n### TURN 2: resume -> hook phai bom bao cao');
const t2 = runCodex(['exec', 'resume', '--last', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-'],
  'Subagent vua bao cao gi? Neu trong context co khoi "Message Type:" thi in nguyen van khoi do. Neu khong co thi tra loi dung: KHONG-CO-BAO-CAO');
const o2 = `${t2.stdout ?? ''}${t2.stderr ?? ''}`;
// Codex in JSONL nÃªn newline trong payload lÃ  HAI kÃ½ tá»± `\` + `n`; vÃ  sá»‘ 6 chá»¯ sá»‘
// náº±m ngay sau tiá»n tá»‘ `n` Ä‘Ã³ -> `\b\d{6}\b` KHÃ”NG khá»›p (n vÃ  2 Ä‘á»u lÃ  word char).
// BÃ¡m Ä‘Ãºng cáº¥u trÃºc: envelope + sá»‘ ngay sau "Payload:".
const sawEnvelope = /Message Type: FINAL_ANSWER/.test(o2);
const sawSecret = /Payload:(?:\\n|\s|\\)*(\d{6})/.test(o2);

console.log('\n### KET QUA');
console.log(`1. Codex goi duoc MCP tool cua ta : ${calledMcp ? 'PASS' : 'FAIL'}`);
console.log(`2. Subagent DSH chay that        : ${reportSeen || sid ? 'PASS' : 'FAIL'}`);
console.log(`3. Hook bom envelope vao turn 2  : ${sawEnvelope && sawSecret ? 'PASS' : 'FAIL'}${sawSecret ? ' (thay so 6 chu so chi subagent biet)' : ''}`);
if (!(sawEnvelope && sawSecret)) console.log(o2.slice(-2000));

// ------------------------------------------------------------------ dÃ¡Â»Ân
if (sid) console.log(`\ndon dep: ${JSON.stringify(runCli(['rm', sid]).stdout?.trim())}`);
fs.rmSync(E2E, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log('da xoa CODEX_HOME tam va thu muc lam viec');
process.exitCode = calledMcp && sawEnvelope && sawSecret ? 0 : 1;
