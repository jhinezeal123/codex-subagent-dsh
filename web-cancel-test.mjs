import assert from 'node:assert/strict';
import { create, prompt, cancel, archive, one } from './dsh-web.mjs';
import { events, until, waitTool, waitEnd } from './web-live-test-helpers.mjs';
const { sessionId } = await create(process.cwd());
try {
  await prompt(sessionId, 'Run pwsh: Start-Sleep -Seconds 300 . Then reply SLEEP-DONE.');
  await waitTool(sessionId);
  const started = Date.now();
  await cancel(sessionId);
  await waitEnd(sessionId);
  await until(async () => (await one(sessionId))?.running === false, 'session stops after cancel', 30000);
  assert.ok(Date.now() - started < 30000, 'cancel must stop a 300s tool promptly');
  const end = (await events(sessionId)).find((e) => e.type === 'turn/end');
  assert.notEqual(end.data.reason.kind, 'completed', 'cancelled turn must not finish normally');
  console.log('PASS: cancel interrupts an executing 300s tool within 30s');
} finally { await archive(sessionId); }
