import './apply-live-cues.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

// Hono composes a child '/' route as the mount path without a trailing slash.
// Change both the real client endpoint and its integration assertions, not the test alone.
for (const path of [
  'apps/web/src/session/liveCueClient.ts',
  'apps/web/src/session/liveCueClient.test.ts',
  'services/token-broker/src/routes/liveCues.test.ts',
]) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('/api/live-cues/')) throw new Error(`Missing canonical-path anchor: ${path}`);
  writeFileSync(path, text.replaceAll('/api/live-cues/', '/api/live-cues'));
}
console.log('Client and actual route now use the same canonical endpoint.');
