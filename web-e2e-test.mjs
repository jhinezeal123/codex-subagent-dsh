/**
 * E2E regression: tao subagent -> steer giua chung -> doc lich su -> archive.
 * Dung: node web-e2e-test.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...a) => execFileSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
const json = (...a) => JSON.parse(cli(...a));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };

const a = json('new', 'Chạy lệnh PowerShell: Start-Sleep -Seconds 40 . Sau đó trả lời đúng một từ: SLEEP-Z', '--label', 'e2e-final');
console.log(`tao ${a.id} · transport ${a.transport}`);
check('new tra ve transport web', a.transport === 'web');

await sleep(9000);
const s1 = json('status', a.id);
check('dang chay truoc khi steer', s1.status === 'running', s1.status);

const st = json('steer', a.id, 'ĐỔI Ý: bỏ qua lệnh ngủ, trả lời đúng một từ: STEER-Z');
check('steer duoc chap nhan', st.accepted === true);

const t0 = Date.now();
while (json('status', a.id).status === 'running' && Date.now() - t0 < 120000) await sleep(3000);
const hist = cli('history', a.id, '--limit', '8');
check('lich su co cau tra loi moi', hist.includes('STEER-Z'));
check('chi 1 turn (steer khong tao turn moi)', (hist.match(/turn \d+ ket thuc/g) ?? []).length === 1, (hist.match(/── turn.*/g) ?? []).join(' | '));
check('turn ket thuc binh thuong', hist.includes('completed'));

const rm = json('rm', a.id);
check('archive duoc', rm.archived === true);
check('khong con trong list', !cli('list').includes(a.id));

console.log(`\n${failed === 0 ? 'E2E OK' : `${failed} muc FAIL`}`);
process.exitCode = failed === 0 ? 0 : 1;
