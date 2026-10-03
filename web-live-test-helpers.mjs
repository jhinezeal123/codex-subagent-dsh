import assert from 'node:assert/strict';
import { readPage } from './dsh-web.mjs';
export const events = async (id) => (await readPage(id, 100)).records.map((r) => r.event ?? r);
export async function until(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`timeout: ${description}`);
}
export const waitTool = (id) => until(async () => (await events(id)).some((e) => e.type === 'tool/call'), 'sleep tool started');
export const waitEnd = (id, count = 1) => until(async () => (await events(id)).filter((e) => e.type === 'turn/end').length >= count, `completed ${count} turns`);
