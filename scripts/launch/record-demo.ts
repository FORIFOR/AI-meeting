import { SessionController } from '../../apps/web/src/session/SessionController.js';
import { DEFAULT_SETTINGS } from '../../apps/web/src/state/settings.js';
import type { SpeakerOutput } from '../../packages/audio-core/src/index.js';
import type { AvatarProvider } from '../../packages/avatar-core/src/index.js';
import type { ConversationEvent, ConversationTask, TaskProposal, ConversationRuntime } from '../../packages/conversation-core/src/index.js';
import type { Persona } from '../../packages/persona-core/src/index.js';

const stage = document.getElementById('stage')!;
const canvas = document.getElementById('recording') as HTMLCanvasElement;
const paint = canvas.getContext('2d')!;
const startButton = document.getElementById('start') as HTMLButtonElement;
const stopButton = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('status')!;
const result = document.getElementById('result')!;
interface Config { broker: string; persona: Persona; prompts: string[]; available: boolean[]; durationLimitSeconds: number }
interface ReadonlySessionInternals { speaker: SpeakerOutput; avatar: AvatarProvider; runtime: ConversationRuntime }
interface EvidenceRow { atMs: number; type: string; [key: string]: unknown }
let config: Config;
let active: { stop: () => void } | null = null;
let disposed = false;
let reviewNotice = '';
let display = { phase: '声で整理して、あとから変更。', input: '', assistant: '', tasks: [] as ConversationTask[], proposals: [] as TaskProposal[], live: false, state: '準備中', seconds: 0 };

function lines(text: string, x: number, y: number, width: number, lineHeight: number, maximum: number) {
  let line = '', count = 0;
  for (const letter of text) {
    if (letter === '\n' || (line && paint.measureText(line + letter).width > width)) {
      paint.fillText(line, x, y + count++ * lineHeight); line = '';
      if (count >= maximum) return;
      if (letter === '\n') continue;
    }
    line += letter;
  }
  if (count < maximum) paint.fillText(line, x, y + count * lineHeight);
}
function card(x: number, y: number, w: number, h: number, fill: string) { paint.fillStyle = fill; paint.beginPath(); paint.roundRect(x, y, w, h, 20); paint.fill(); }
function draw() {
  paint.fillStyle = '#f0f3ed'; paint.fillRect(0, 0, 1280, 720);
  paint.fillStyle = '#174a43'; paint.font = '700 24px system-ui'; paint.fillText('AI Meeting', 48, 54);
  paint.font = '13px system-ui'; paint.fillStyle = '#52675e'; paint.fillText('録画用レイアウト  ·  入力は合成音声  ·  応答は実API', 628, 52);
  paint.fillStyle = '#102d29'; paint.font = '700 35px system-ui'; paint.fillText(display.phase, 48, 111);
  card(40, 145, 470, 520, '#e2e9df');
  const vrm = stage.querySelector('canvas');
  if (vrm?.width && vrm.height) paint.drawImage(vrm, 40, 145, 470, 520);
  paint.font = '14px system-ui'; paint.fillStyle = '#466052'; paint.fillText(display.state, 66, 636);
  card(536, 145, 700, 141, '#ffffff');
  paint.font = '700 14px system-ui'; paint.fillStyle = '#537867'; paint.fillText('あなた  ·  デモ用合成音声', 560, 174);
  paint.font = '20px system-ui'; paint.fillStyle = '#16372f'; lines(display.input || '入力を待っています。', 560, 205, 648, 29, 3);
  card(536, 304, 700, 137, '#174a43');
  paint.font = '700 14px system-ui'; paint.fillStyle = '#bcddc9'; paint.fillText('AI  ·  Gemini Live の実応答', 560, 333);
  paint.font = '22px system-ui'; paint.fillStyle = '#ffffff'; lines(display.assistant || (display.live ? '…' : '接続前'), 560, 366, 645, 30, 2);
  card(536, 459, 700, 206, '#ffffff');
  const proposedTasks = display.proposals.flatMap(proposal => proposal.changes);
  paint.font = '700 17px system-ui'; paint.fillStyle = '#16372f'; paint.fillText(proposedTasks.length ? 'AIの変更提案 · 確認待ち（未反映）' : '会話から記録されたタスク', 560, 492);
  if (!display.tasks.length && !proposedTasks.length) { paint.font = '18px system-ui'; paint.fillStyle = '#687b71'; paint.fillText('まだ記録はありません。', 560, 533); }
  (proposedTasks.length ? proposedTasks : display.tasks).slice(0, 2).forEach((task, i) => {
    const y = 529 + i * 49;
    paint.font = '700 15px system-ui'; paint.fillStyle = task.status === 'done' ? '#2f7655' : '#6d5e36';
    paint.fillText(task.status === 'done' ? '✓ 完了' : task.status === 'deferred' ? '↗ 延期' : '○ 未完了', 560, y);
    paint.font = '19px system-ui'; paint.fillStyle = '#16372f'; lines(task.title, 650, y, 549, 25, 1);
    if (task.due) { paint.font = '13px system-ui'; paint.fillStyle = '#687b71'; paint.fillText('期限: ' + task.due, 650, y + 20); }
  });
  if (reviewNotice) { paint.font = '14px system-ui'; paint.fillStyle = '#537867'; lines(reviewNotice, 560, 632, 648, 18, 1); }
  paint.font = '12px system-ui'; paint.fillStyle = '#687b71';
  paint.fillText('VRM1_Constraint_Twist_Sample © 2022 pixiv Inc.  /  ローカル描画・アバター生成APIなし', 48, 696);
  paint.fillText(`${display.live ? '● 実セッション' : '待機'}  ${Math.floor(display.seconds)}秒`, 1070, 696);
}
draw();

async function record(): Promise<void> {
  if (active || disposed) return;
  const id = crypto.randomUUID(), abort = new AbortController(), rows: EvidenceRow[] = [];
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  const originalFetch = window.fetch;
  let inputContext: AudioContext | null = null, controller: SessionController | null = null;
  let mediaRecorder: MediaRecorder | null = null, videoStream: MediaStream | null = null, recordingStream: MediaStream | null = null;
  let audioBranch: AudioNode | null = null, inputBranch: AudioNode | null = null, source: AudioBufferSourceNode | null = null;
  let inputStream: MediaStream | null = null, tick: number | null = null;
  let recordingDestination: MediaStreamAudioDestinationNode | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null, recordedAt = 0, tokenRequests = 0, peak = 0, audioFrames = 0;
  let currentGeneration = 0, minimumGeneration = 0, assistantFinal = true, inputFinal = true;
  let lastAudioAt = 0, interruptWhilePlaying = false;
  let inputIndex = 0;
  let reviewPending: () => Promise<void> = async () => {};
  let untap: (() => void) | null = null;
  let stopRecorder: (() => Promise<Blob>) | null = null;
  const clock = () => recordedAt ? Math.round(performance.now() - recordedAt) : 0;
  const updatedAsRequested = () => display.tasks.some(task => task.title === '資料確認' && task.status === 'done') && display.tasks.some(task => task.title === 'メール返信' && task.status === 'deferred' && task.due === '明日');
  const note = (type: string, fields: Record<string, unknown> = {}) => rows.push({ atMs: clock(), type, ...fields });
  const stop = () => { abort.abort(); try { source?.stop(); } catch {} };
  const check = () => { if (abort.signal.aborted || disposed) throw new DOMException('録画を停止しました', 'AbortError'); };
  const pause = async (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { check(); await new Promise(resolve => setTimeout(resolve, Math.min(80, until - performance.now()))); } };
  const until = async (condition: () => boolean, maxMs: number) => { const end = performance.now() + maxMs; while (!condition() && performance.now() < end) { await reviewPending(); await pause(80); } };
  active = { stop }; startButton.disabled = true; stopButton.disabled = false;
  display = { phase: '声で整理して、あとから変更。', input: '', assistant: '', tasks: [], proposals: [], live: false, state: '接続準備中', seconds: 0 };
  reviewNotice = '';
  let failed: string | null = null, blob: Blob | null = null;
  try {
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find(value => MediaRecorder.isTypeSupported(value));
    if (!mime) throw new Error('このブラウザーはWebM録画に対応していません。');
    // This isolated development page substitutes only the microphone with the disclosed WAV stream.
    // SessionController, MicCapture, provider, task validation and playback remain their actual code.
    inputContext = new AudioContext({ sampleRate: 48000 }); await inputContext.resume(); check();
    const inputDestination = inputContext.createMediaStreamDestination(); inputStream = inputDestination.stream;
    navigator.mediaDevices.getUserMedia = async () => inputDestination.stream;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/token/gemini' && ++tokenRequests > 1) throw new Error('録画1回につき接続は1回に制限しています。');
      return originalFetch(input, options);
    };
    const buffers: AudioBuffer[] = [];
    for (const index of [1, 2, 3]) {
      const response = await originalFetch(`/capture/input/${index}.wav`);
      if (!response.ok) throw new Error('合成音声の素材がありません。');
      buffers.push(await inputContext.decodeAudioData(await response.arrayBuffer()));
      check();
    }
    const onEvent = (event: ConversationEvent) => {
      const gen = 'gen' in event ? event.gen?.generationId : undefined;
      if (event.type === 'interrupted') { minimumGeneration = Math.max(minimumGeneration, (gen ?? currentGeneration) + 1); display.assistant = ''; assistantFinal = true; note('interrupted'); }
      if (gen !== undefined && event.type.startsWith('assistant_')) { if (gen < minimumGeneration) return; currentGeneration = gen; }
      if (event.type === 'user_transcript') { display.input = event.delta && !inputFinal ? display.input + event.text : event.text; inputFinal = event.final !== false; note('user_transcript', { text: event.text, final: event.final }); }
      if (event.type === 'assistant_speech_started') { if (assistantFinal) display.assistant = ''; assistantFinal = false; }
      if (event.type === 'assistant_transcript') { display.assistant = !assistantFinal && event.final === false ? display.assistant + event.text : event.text; assistantFinal = event.final === true; note('assistant_transcript', { text: event.text, final: event.final }); }
      if (event.type === 'assistant_speech_ended') assistantFinal = true;
      if (event.type === 'tool_call') note('tool_call', { name: event.call.name, arguments: event.call.arguments });
    };
    controller = new SessionController({
      settings: { ...DEFAULT_SETTINGS, brokerUrl: config.broker, agentUrl: 'ws://127.0.0.1:1', engine: 'google', advanced: {}, privacyMode: 'default',
        characterId: 'vrm-sample', avatarQuality: { 'vrm-sample': 'lightweight' }, cameraOn: false, captionsOn: true },
      availability: { google: true, openai: false, local: false }, persona: config.persona, params: { horizon: '今日' },
      character: { id: 'vrm-sample', name: 'VRMサンプル', renderer: 'vrm', baseUrl: '/characters/vrm-sample' }, stage,
      handlers: { onEvent, onAvatarState: event => { display.state = event.to; }, onProviderChange: value => note('provider', { value }),
        onError: (_message, code) => { note('session_notice', { code: code ?? 'unknown' }); if (code === 'PROVIDER' || code === 'AVATAR_FALLBACK') { failed = '実接続またはVRM表示を確認できませんでした。'; stop(); } },
        onTasks: tasks => { display.tasks = tasks; note('tasks', { tasks }); }, onTaskProposals: proposals => { display.proposals = proposals; note('task_proposals', { proposals }); },
      },
    });
    deadline = setTimeout(stop, 25000);
    status.textContent = '実Geminiセッションへ接続しています。';
    await Promise.race([controller.start(), new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new DOMException('接続を中断しました', 'AbortError')), { once: true }))]);
    clearTimeout(deadline); check(); navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    const internals = controller as unknown as ReadonlySessionInternals;
    // Observe actual task-tool replies in this demo-only session; never modify their contents.
    const sendToolResponse = internals.runtime.sendToolResponse.bind(internals.runtime);
    internals.runtime.sendToolResponse = responses => {
      for (const response of responses) if (response.name === 'session_tasks') note('tool_response', { response: response.response });
      sendToolResponse(responses);
    };
    const reviewed = new Set<string>();
    reviewPending = async () => {
      const proposal = display.proposals.find(value => !reviewed.has(value.id));
      if (!proposal) return;
      reviewed.add(proposal.id);
      // The supplied voice script explicitly specifies these values. Never accept a guessed
      // deadline, changed title, unknown task, or only partly matching batch to improve a video.
      const expected = (task: ConversationTask) => {
        if (!['資料確認', 'メール返信'].includes(task.title)) return false;
        if (inputIndex === 0) return task.status === 'pending' && task.due === '今日';
        if (!display.tasks.some(current => current.id === task.id && current.title === task.title)) return false;
        return task.title === '資料確認' ? task.status === 'done' && task.due === '今日' : task.status === 'deferred' && task.due === '明日';
      };
      if (!proposal.changes.length || !proposal.changes.every(expected)) {
        reviewNotice = '台本と一致しない提案は反映しません。';
        note('proposal_not_confirmed', { proposal }); return;
      }
      reviewNotice = '台本と照合中 → この変更を反映（録画シナリオ）';
      note('proposal_review_started', { proposal, review: 'exact match to disclosed synthetic input' });
      await pause(1800); check();
      if (!display.proposals.some(value => value.id === proposal.id) || !proposal.changes.every(expected)) return;
      controller!.resolveTaskProposal(proposal.id, true);
      reviewNotice = '台本と一致する提案を確認して反映（録画シナリオ）';
      note('proposal_confirmation_action', { proposalId: proposal.id, actualTasks: display.tasks });
    };
    const speaker = internals.speaker;
    if (internals.avatar.id !== 'vrm' || !stage.querySelector('canvas')) throw new Error('実VRMの描画がありません。');
    // Recording-only branch of the existing final audio node. No second playback scheduling.
    audioBranch = (speaker as unknown as { tapNode: { node: AudioNode } }).tapNode.node;
    const mix = speaker.context.createMediaStreamDestination(); recordingDestination = mix; audioBranch.connect(mix);
    inputBranch = speaker.context.createMediaStreamSource(inputDestination.stream); inputBranch.connect(mix);
    untap = speaker.tap.subscribe(frame => { for (let i = 0; i < frame.data.length; i += 4) peak = Math.max(peak, Math.abs(frame.data[i] ?? 0)); if (frame.data.some(value => Math.abs(value) > .005)) { lastAudioAt = performance.now(); audioFrames++; } });
    display.live = true; recordedAt = performance.now(); draw();
    // Read the VRM WebGL canvas in the same animation frame, before its drawing buffer clears.
    const drawFrame = () => { display.seconds = clock() / 1000; draw(); tick = requestAnimationFrame(drawFrame); };
    tick = requestAnimationFrame(drawFrame);
    videoStream = canvas.captureStream(30); recordingStream = new MediaStream([...videoStream.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: mime, videoBitsPerSecond: 2800000, audioBitsPerSecond: 128000 });
    const parts: Blob[] = []; const stopped = new Promise<Blob>((resolve, reject) => { mediaRecorder!.ondataavailable = event => { if (event.data.size) parts.push(event.data); }; mediaRecorder!.onstop = () => resolve(new Blob(parts, { type: mime })); mediaRecorder!.onerror = () => reject(new Error('録画エンコーダーが停止しました。')); });
    stopped.catch(() => {});
    stopRecorder = () => { if (mediaRecorder!.state !== 'inactive') mediaRecorder!.stop(); return stopped; };
    mediaRecorder.start(1000); note('recording_started', { syntheticInput: true, inputVoice: 'macOS Kyoko', layout: 'recording compositor', provider: 'google', avatar: 'vrm', mime });
    deadline = setTimeout(stop, config.durationLimitSeconds * 1000);
    status.textContent = '録画中：合成音声入力 → 実AI返答 → タスク更新。最大60秒で切断します。';
    const speak = async (index: number) => {
      check(); inputIndex = index; display.input = config.prompts[index] ?? ''; inputFinal = true;
      note('synthetic_input_started', { index, text: display.input, duration: buffers[index]!.duration });
      source = inputContext!.createBufferSource(); source.buffer = buffers[index]!; source.connect(inputDestination); source.start();
      await pause(buffers[index]!.duration * 1000 + 150); source.disconnect(); source = null; note('synthetic_input_ended', { index });
    };
    await pause(500); await speak(0);
    await until(() => display.tasks.length >= 2 && speaker.isPlaying && audioFrames > 0, 18000);
    await pause(1200); check();
    interruptWhilePlaying = speaker.isPlaying;
    display.phase = interruptWhilePlaying ? '話を止めて、その場で変更。' : '終わったことも、その場で変更。';
    note('change_requested', { interruptWhilePlaying, tasksBefore: display.tasks });
    await controller.interrupt(); await pause(200); await speak(1);
    await until(() => updatedAsRequested() && !speaker.isPlaying && performance.now() - lastAudioAt > 1500, 20000);
    if (updatedAsRequested() && rows.some(row => row.type === 'proposal_confirmation_action')) {
      // Confirmation happened after the preceding answer was generated. Ask the real provider
      // to read the current ledger so the closing answer also reflects the actual saved state.
      display.phase = '記録を確かめて、次の一歩へ。';
      const followUpAt = performance.now(); note('confirmation_follow_up');
      await speak(2);
      await until(() => lastAudioAt > followUpAt && !speaker.isPlaying && performance.now() - lastAudioAt > 1500, 12000);
    }
    display.phase = '話した内容が、次の行動になる。';
    await pause(Math.max(2500, 45000 - clock()));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) failed = '録画を完了できませんでした。記録ファイルで実行結果を確認してください。';
    note('stopped', { reason: failed ? 'error' : 'duration_or_operator' });
  } finally {
    if (deadline) clearTimeout(deadline);
    const finalRecording = stopRecorder?.();
    if (tick !== null) cancelAnimationFrame(tick);
    const remainingSource = source as AudioBufferSourceNode | null;
    try { remainingSource?.stop(); } catch {} remainingSource?.disconnect();
    untap?.();
    // Disconnect only this helper's recorder branches, preserving the actual speaker owner.
    if (audioBranch && recordingDestination) { try { audioBranch.disconnect(recordingDestination); } catch {} }
    inputBranch?.disconnect();
    for (const track of recordingStream?.getTracks() ?? []) track.stop();
    for (const track of videoStream?.getTracks() ?? []) track.stop();
    for (const track of inputStream?.getTracks() ?? []) track.stop();
    await controller?.dispose().catch(() => {});
    await inputContext?.close().catch(() => {});
    navigator.mediaDevices.getUserMedia = originalGetUserMedia; window.fetch = originalFetch;
    // Always disconnect the paid session first; a stalled browser encoder cannot extend it.
    if (finalRecording) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { blob = await Promise.race([finalRecording, new Promise<Blob>((_, reject) => { timeout = setTimeout(() => reject(new Error('Encoder timeout')), 5000); })]); }
      catch { failed = '録画データを確定できませんでした。'; }
      finally { if (timeout) clearTimeout(timeout); }
    }
    display.live = false;
    const summary = { id, at: new Date().toISOString(), durationMs: clock(), tokenRequests, peak, audioFrames, interruptWhilePlaying,
      actualTasks: display.tasks, pendingProposals: display.proposals, failed, captured: !!blob?.size,
      requirementsObserved: { realAssistantAudio: peak > .005, tasksAdded: display.tasks.length >= 2, taskUpdated: updatedAsRequested() }, rows };
    try {
      if (blob?.size) { const saved = await originalFetch(`/capture/${id}/video`, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: blob }); if (!saved.ok) throw new Error('video save failed'); }
      const saved = await originalFetch(`/capture/${id}/evidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) }); if (!saved.ok) throw new Error('evidence save failed');
      status.textContent = failed ?? '録画をローカルへ保存しました。内容と実行記録を確認してください。';
      result.textContent = JSON.stringify({ id, files: [`${id}.webm`, `${id}.json`], ...summary.requirementsObserved, interruptWhilePlaying, failed }, null, 2);
    } catch { status.textContent = '保存に失敗しました。ページを閉じず、実行記録を確認してください。'; }
    active = null; stopButton.disabled = true; startButton.disabled = disposed; draw();
  }
}
startButton.onclick = () => { void record(); }; stopButton.onclick = () => active?.stop();
addEventListener('pagehide', () => { disposed = true; active?.stop(); });
void fetch('/capture/config').then(response => response.json()).then((value: Config) => {
  config = value; const ready = value.available.every(Boolean);
  status.textContent = ready ? '準備できました。開始すると実Gemini接続を1回行い、最大60秒で切断します。' : '入力WAVがありません。サーバーを --prepare-voice 付きで起動してください。';
  startButton.disabled = !ready;
}).catch(() => { status.textContent = '録画の設定を読み込めませんでした。'; });
