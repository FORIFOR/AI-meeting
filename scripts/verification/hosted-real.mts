/** Creates a disposable synthetic Auth user, never sends email, and deletes it in finally. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const require = createRequire(new URL('../../services/token-broker/package.json', import.meta.url));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { WebSocket } = require('ws');
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const broker = process.env.BROKER_URL;
assert.ok(projectId && broker, 'GOOGLE_CLOUD_PROJECT and BROKER_URL are required');
const sdk = getAuth(initializeApp({ projectId, credential: applicationDefault() }, 'hosted-validation'));
const uid = `automated-validation-${randomBytes(12).toString('hex')}`;
const email = `${uid}@example.invalid`, password = randomBytes(30).toString('base64url');
const config = await (await fetch(process.env.FIREBASE_CONFIG_URL || 'https://ai-meeting.web.app/__/firebase/init.json')).json() as { apiKey: string };
const pcm = process.env.INPUT_PCM ? await readFile(process.env.INPUT_PCM) : undefined;
const results: Record<string, unknown> = { input: pcm ? 'synthetic PCM16k' : 'text', responseShapes: [] };
let created = false;
const signIn = async () => {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const data = await response.json() as { idToken?: string; error?: { message?: string } };
  assert.equal(response.status, 200, data.error?.message);
  assert.ok(data.idToken); return data.idToken;
};
const reserve = (token?: string) => fetch(`${broker}/api/hosted/session`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
try {
  await sdk.createUser({ uid, email, password, emailVerified: false }); created = true;
  results.unauthenticatedStatus = (await reserve()).status; assert.equal(results.unauthenticatedStatus, 401);
  const unverified = await signIn();
  results.unverifiedStatus = (await reserve(unverified)).status; assert.equal(results.unverifiedStatus, 403);
  await sdk.updateUser(uid, { emailVerified: true });
  const verified = await signIn();
  const admitted = await reserve(verified);
  const grant = await admitted.json() as { token?: string; sessionSeconds?: number; message?: string; model?: string };
  assert.equal(admitted.status, 200, grant.message); assert.ok(grant.token);
  results.verifiedStatus = admitted.status; results.dailyLimitStatus = (await reserve(verified)).status;
  assert.equal(results.dailyLimitStatus, 429);
  const url = new URL(broker); url.protocol = 'wss:'; url.pathname = '/api/live/vertex'; url.searchParams.set('ticket', grant.token!);
  const start = Date.now();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url.href);
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('relay did not enforce its duration')); }, ((grant.sessionSeconds ?? 180) + 20) * 1000);
    let ready = false, audioBytes = 0, transcriptCharacters = 0;
    ws.on('open', () => ws.send(JSON.stringify({ setup: { model: grant.model, generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }, realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, systemInstruction: { parts: [{ text: 'あなたはAI Meetingの会話パートナーです。日本語で短く一言だけ答えてください。' }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } })));
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if ((results.responseShapes as unknown[]).length < 8) (results.responseShapes as unknown[]).push({ keys: Object.keys(message), content: Object.keys(message.serverContent ?? {}), parts: (message.serverContent?.modelTurn?.parts ?? []).map((p: any) => Object.keys(p)) });
      if (message.setupComplete) {
        ready = true;
        if (pcm) {
          void (async () => {
            ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            for (let offset = 0; offset < pcm.length && ws.readyState === WebSocket.OPEN; offset += 3200) {
              ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.subarray(offset, offset + 3200).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
              await new Promise(r => setTimeout(r, 100));
            }
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
          })().catch(reject);
        } else ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'こんにちは。今日のタスクを一緒に整理しましょう、と一言だけ言ってください。' }] }], turnComplete: true } }));
      }
      for (const part of message.serverContent?.modelTurn?.parts ?? []) if (part.inlineData?.data) audioBytes += Buffer.byteLength(part.inlineData.data, 'base64');
      transcriptCharacters += (message.serverContent?.outputTranscription?.text ?? '').length;
    });
    ws.on('error', error => { clearTimeout(timeout); reject(error); });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      results.live = { ready, audioBytes, transcriptCharacters, closeCode: code, closeReason: reason.toString(), elapsedMs: Date.now() - start };
      try { assert.equal(ready, true); assert.ok(audioBytes > 0); assert.equal(code, 1008); assert.equal(reason.toString(), 'HOSTED_SESSION_LIMIT'); resolve(); } catch (e) { reject(e); }
    });
  });
  results.replayStatus = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url.href);
    ws.on('unexpected-response', (_request, response) => { resolve(response.statusCode); response.resume(); ws.terminate(); });
    ws.on('open', () => { ws.terminate(); reject(new Error('consumed ticket replayed')); });
    ws.on('error', () => {});
  });
  assert.equal(results.replayStatus, 401);
  results.passed = true;
} finally {
  if (created) { await sdk.deleteUser(uid); results.syntheticAccountDeleted = true; }
  await mkdir('artifacts/hosted-access', { recursive: true });
  await writeFile(`artifacts/hosted-access/real-verification-${pcm ? 'audio' : 'text'}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
