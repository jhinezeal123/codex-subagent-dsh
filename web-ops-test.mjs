import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archive, answerFrom, one } from './dsh-web.mjs';
import { events, until, waitTool, waitEnd } from './web-live-test-helpers.mjs';
const CLI = fileURLToPath(new URL('./dsh-agent.mjs', import.meta.url));
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
const created = [];
const start = () => {
  const agent = JSON.parse(cli('new', 'Run pwsh: Start-Sleep -Seconds 300 . Then reply SLEEP-DONE.', '--label', 'verify-ops'));
  assert.equal(agent.transport, 'web');
  created.push(agent.id);
  return agent.id;
};
try {
  const interrupted = start();
  await waitTool(interrupted);
  const started = Date.now();
  cli('interrupt', interrupted, 'Do not call tools. Reply only INTERRUPT-OK.');
  await waitEnd(interrupted, 2);
  assert.ok(Date.now() - started < 120000, 'interrupt must bypass the 300s sleep');
  assert.match(answerFrom(await events(interrupted)), /INTERRUPT-OK/);
  console.log('PASS: interrupt stops the tool and completes a replacement turn');
  const stopped = start();
  await waitTool(stopped);
  assert.equal(JSON.parse(cli('stop', stopped)).stopped, true);
  await waitEnd(stopped);
  await until(async () => (await one(stopped))?.running === false, 'stop reaches idle', 30000);
  assert.equal((await events(stopped)).filter((e) => e.type === 'turn/end').length, 1);
  console.log('PASS: stop reaches idle without creating another turn');
} finally { for (const id of created) await archive(id); }
