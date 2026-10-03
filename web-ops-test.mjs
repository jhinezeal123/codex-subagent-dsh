/**
 * Test 3 thao tac chen ngang qua CLI THAT (duong web): steer, interrupt, stop.
 * Dung: node web-ops-test.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(DIR, 'dsh-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const cliJson = (...args) => JSON.parse(cli(...args));
const waitIdle = async (id, maxMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (cliJson('status', id).status === 'idle') return Math.round((Date.now() - t0) / 1000);
    await sleep(3000);
  }
  return -1;
};

console.log('################ A. STEER giua chung ################');
const a = cliJson('new', 'Chạy lệnh PowerShell: Start-Sleep -Seconds 40 . Sau đó trả lời: SLEEP-A', '--label', 'test-steer');
log(`tao ${a.id} (transport ${a.transport})`);
await sleep(8000);
log('status truoc steer:', cliJson('status', a.id).status);
log('steer:', cli('steer', a.id, 'ĐỔI Ý: bỏ qua lệnh ngủ, trả lời đúng một từ: STEER-A').trim());
log(`cho ket thuc... ${await waitIdle(a.id, 120000)}s`);
log('history:\n' + cli('history', a.id, '--limit', '6').trim());

console.log('\n################ B. INTERRUPT (dung ngay + prompt moi) ################');
const b = cliJson('new', 'Chạy lệnh PowerShell: Start-Sleep -Seconds 300 . Sau đó trả lời: SLEEP-B', '--label', 'test-interrupt');
log(`tao ${b.id}`);
await sleep(8000);
log('interrupt:', cli('interrupt', b.id, 'Trả lời ngay, đúng một từ: INTERRUPT-B').trim());
const dtB = await waitIdle(b.id, 120000);
log(`tu interrupt den khi xong: ${dtB}s (nho hon 300 => da cat that)`);
log('history:\n' + cli('history', b.id, '--limit', '8').trim());

console.log('\n################ C. STOP (dung han) ################');
const c = cliJson('new', 'Chạy lệnh PowerShell: Start-Sleep -Seconds 300 . Sau đó trả lời: SLEEP-C', '--label', 'test-stop');
log(`tao ${c.id}`);
await sleep(8000);
log('stop:', cli('stop', c.id).trim());
const dtC = await waitIdle(c.id, 90000);
log(`tu stop den khi dung: ${dtC}s`);
log('history:\n' + cli('history', c.id, '--limit', '4').trim());

console.log('\n################ D. LIST ################');
console.log(cli('list').trim());
