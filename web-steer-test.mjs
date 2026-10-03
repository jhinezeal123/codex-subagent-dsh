import assert from 'node:assert/strict';
import { create, prompt, archive, answerFrom } from './dsh-web.mjs';
import { events, waitTool, waitEnd } from './web-live-test-helpers.mjs';
const { sessionId } = await create(process.argv[2] || process.cwd());
try {
  await prompt(sessionId, 'Run pwsh: Start-Sleep -Seconds 12 . Then reply only SLEEP-DONE.');
  await waitTool(sessionId);
  const steered = await prompt(sessionId, 'CHANGE: after the current command finishes, reply only STEER-OK.', 'steer');
  assert.equal(steered.accepted, true);
  await waitEnd(sessionId);
  const records = await events(sessionId);
  assert.match(answerFrom(records), /STEER-OK/);
  assert.equal(records.filter((e) => e.type === 'turn/end').length, 1);
  assert.equal(records.find((e) => e.type === 'turn/end').data.reason.kind, 'completed');
  console.log('PASS: steer changes the answer within one completed turn');
} finally { await archive(sessionId); }
