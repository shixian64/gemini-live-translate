const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LOCAL_STORAGE_PREFIX = 'gemini-live-translate.web.';
const MAX_HISTORY = 25;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const els = {
  apiKey: document.querySelector('#apiKey'),
  rememberKey: document.querySelector('#rememberKey'),
  modelName: document.querySelector('#modelName'),
  targetLanguage: document.querySelector('#targetLanguage'),
  sourceMode: document.querySelector('#sourceMode'),
  chunkDuration: document.querySelector('#chunkDuration'),
  showBilingual: document.querySelector('#showBilingual'),
  enablePlayback: document.querySelector('#enablePlayback'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  clearButton: document.querySelector('#clearButton'),
  statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'),
  statsText: document.querySelector('#statsText'),
  subtitleList: document.querySelector('#subtitleList'),
  platformLabel: document.querySelector('#platformLabel'),
  platformHint: document.querySelector('#platformHint'),
  logOutput: document.querySelector('#logOutput'),
};

const state = {
  isRunning: false,
  setupSent: false,
  ws: null,
  captureStream: null,
  audioContext: null,
  sourceNode: null,
  workletNode: null,
  scriptProcessor: null,
  muteNode: null,
  downsampler: null,
  playbackContext: null,
  playbackTime: 0,
  chunkCount: 0,
  droppedChunks: 0,
  rotateTimer: 0,
  history: [],
  currentLine: createSubtitleLine(),
};

class MainThreadDownsampler {
  constructor({ inputSampleRate, targetSampleRate, chunkFrameCount, onChunk }) {
    this.inputSampleRate = inputSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.chunkFrameCount = chunkFrameCount;
    this.onChunk = onChunk;
    this.ratio = inputSampleRate / targetSampleRate;
    this.source = new Float32Array(0);
    this.readIndex = 0;
    this.output = new Int16Array(chunkFrameCount);
    this.outputOffset = 0;
  }

  push(channels) {
    if (!channels.length || !channels[0].length) {
      return;
    }
    const frameCount = channels[0].length;
    const mono = new Float32Array(frameCount);
    for (const channel of channels) {
      for (let index = 0; index < frameCount; index += 1) {
        mono[index] += channel[index] / channels.length;
      }
    }

    const merged = new Float32Array(this.source.length + mono.length);
    merged.set(this.source, 0);
    merged.set(mono, this.source.length);
    this.source = merged;
    this.drain();
  }

  drain() {
    while (this.readIndex + 1 < this.source.length) {
      const base = Math.floor(this.readIndex);
      const fraction = this.readIndex - base;
      const current = this.source[base];
      const next = this.source[base + 1];
      const sample = current + (next - current) * fraction;
      this.writeSample(sample);
      this.readIndex += this.ratio;
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.source = this.source.slice(consumed);
      this.readIndex -= consumed;
    }
  }

  writeSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.output[this.outputOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.outputOffset += 1;

    if (this.outputOffset >= this.output.length) {
      this.emitChunk();
    }
  }

  emitChunk() {
    const chunk = this.output;
    this.onChunk(chunk.buffer);
    this.output = new Int16Array(this.chunkFrameCount);
    this.outputOffset = 0;
  }

  flush() {
    if (this.outputOffset === 0) {
      return;
    }
    const chunk = this.output.slice(0, this.outputOffset);
    this.onChunk(chunk.buffer);
    this.output = new Int16Array(this.chunkFrameCount);
    this.outputOffset = 0;
  }
}

init();

function init() {
  restorePreferences();
  const platform = detectPlatform();
  els.platformLabel.textContent = platform.label;
  els.platformHint.textContent = platform.hint;
  if (!localStorage.getItem(`${LOCAL_STORAGE_PREFIX}sourceMode`)) {
    els.sourceMode.value = platform.preferredSource;
  }

  if (!navigator.mediaDevices) {
    setStatus('当前浏览器不支持媒体采集 API', 'error');
  } else if (!isLikelySecureContext()) {
    setStatus('建议通过 HTTPS 或 localhost 打开，否则浏览器可能拒绝音频采集', 'warn');
  } else {
    setStatus('未连接', 'idle');
  }

  els.startButton.addEventListener('click', start);
  els.stopButton.addEventListener('click', () => stop({ status: '已停止', statusType: 'idle' }));
  els.clearButton.addEventListener('click', clearSubtitles);
  els.showBilingual.addEventListener('change', renderSubtitles);
  els.rememberKey.addEventListener('change', persistPreferences);
  els.modelName.addEventListener('change', persistPreferences);
  els.targetLanguage.addEventListener('change', persistPreferences);
  els.sourceMode.addEventListener('change', persistPreferences);
  els.chunkDuration.addEventListener('change', persistPreferences);

  updateStats();
  log('Web/PWA 跨平台适配已加载。');
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isAndroid = /Android/i.test(ua);
  const isWindows = /Win/i.test(platform) || /Windows/i.test(ua);
  const isLinux = /Linux/i.test(platform) && !isAndroid;

  if (isAndroid) {
    return {
      label: 'Android',
      preferredSource: 'microphone',
      hint: '多数 Android 浏览器不能采集系统音频，默认使用麦克风模式。',
    };
  }
  if (isWindows) {
    return {
      label: 'Windows',
      preferredSource: 'display',
      hint: '推荐 Chrome/Edge，分享标签页或屏幕时勾选“共享音频”。',
    };
  }
  if (isLinux) {
    return {
      label: 'Linux',
      preferredSource: 'display',
      hint: '推荐 Chromium/Chrome，桌面音频权限取决于发行版与浏览器。',
    };
  }
  return {
    label: '未知/其他平台',
    preferredSource: 'microphone',
    hint: '可先尝试麦克风模式；桌面浏览器可尝试屏幕/标签页音频。',
  };
}

function isLikelySecureContext() {
  return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function restorePreferences() {
  const remember = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}rememberKey`) === 'true';
  els.rememberKey.checked = remember;
  if (remember) {
    els.apiKey.value = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}apiKey`) || '';
  }
  els.modelName.value = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}modelName`) || els.modelName.value;
  els.targetLanguage.value = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}targetLanguage`) || els.targetLanguage.value;
  els.sourceMode.value = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}sourceMode`) || els.sourceMode.value;
  els.chunkDuration.value = localStorage.getItem(`${LOCAL_STORAGE_PREFIX}chunkDuration`) || els.chunkDuration.value;
}

function persistPreferences() {
  localStorage.setItem(`${LOCAL_STORAGE_PREFIX}rememberKey`, String(els.rememberKey.checked));
  if (els.rememberKey.checked) {
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}apiKey`, els.apiKey.value.trim());
  } else {
    localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}apiKey`);
  }
  localStorage.setItem(`${LOCAL_STORAGE_PREFIX}modelName`, els.modelName.value.trim());
  localStorage.setItem(`${LOCAL_STORAGE_PREFIX}targetLanguage`, els.targetLanguage.value.trim());
  localStorage.setItem(`${LOCAL_STORAGE_PREFIX}sourceMode`, els.sourceMode.value);
  localStorage.setItem(`${LOCAL_STORAGE_PREFIX}chunkDuration`, els.chunkDuration.value);
}

async function start() {
  if (state.isRunning) {
    return;
  }

  const apiKey = els.apiKey.value.trim();
  const modelName = normalizeModelName(els.modelName.value.trim());
  const targetLanguage = els.targetLanguage.value.trim() || 'zh-CN';

  if (!apiKey) {
    setStatus('请先输入 Gemini API Key', 'error');
    els.apiKey.focus();
    return;
  }
  if (!modelName) {
    setStatus('请先输入模型名称', 'error');
    els.modelName.focus();
    return;
  }

  clearSubtitles();
  persistPreferences();
  setRunningUi(true);
  setStatus('正在连接 Gemini Live…', 'warn');

  try {
    await openWebSocket({ apiKey, modelName, targetLanguage });
    await startAudioCapture();
    state.isRunning = true;
    setStatus('已连接，正在翻译', 'ok');
    log(`启动完成：model=${modelName}, targetLanguage=${targetLanguage}, source=${els.sourceMode.value}`);
  } catch (error) {
    log(`启动失败：${error.message}`);
    await stop({ status: `启动失败：${error.message}`, statusType: 'error' });
  }
}

async function openWebSocket({ apiKey, modelName, targetLanguage }) {
  const url = new URL(`wss://${GEMINI_HOST}${GEMINI_PATH}`);
  url.searchParams.set('key', apiKey);

  state.ws = new WebSocket(url.toString());
  state.setupSent = false;

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('WebSocket 连接超时'));
    }, 15000);

    state.ws.addEventListener('open', () => {
      window.clearTimeout(timeout);
      sendSetupConfig(modelName, targetLanguage);
      resolve();
    }, { once: true });

    state.ws.addEventListener('error', () => {
      window.clearTimeout(timeout);
      reject(new Error('WebSocket 连接失败'));
    }, { once: true });
  });

  state.ws.addEventListener('message', handleServerMessage);
  state.ws.addEventListener('close', (event) => {
    log(`WebSocket 已关闭：code=${event.code}${event.reason ? `, reason=${event.reason}` : ''}`);
    if (state.isRunning) {
      setStatus(`WebSocket 已关闭（${event.code}）`, 'error');
      stop({ status: `WebSocket 已关闭（${event.code}）`, statusType: 'error' });
    }
  });
  updateStats();
}

function sendSetupConfig(modelName, targetLanguage) {
  const setupMessage = buildSetupMessage(modelName, targetLanguage);
  state.ws.send(JSON.stringify(setupMessage));
  state.setupSent = true;
  log('Setup Config 已发送。');
}

function buildSetupMessage(modelName, targetLanguage) {
  const model = `models/${normalizeModelName(modelName)}`;
  const isTranslateModel = modelName.includes('live-translate');

  if (isTranslateModel) {
    return {
      setup: {
        model,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: targetLanguage,
            echoTargetLanguage: true,
          },
        },
      },
    };
  }

  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
      },
      systemInstruction: {
        parts: [
          {
            text: `你是一个专业的实时口译助手。请听取输入音频，并将其即时、通顺地翻译成 ${targetLanguage}，同时输出语音和字幕。`,
          },
        ],
      },
    },
  };
}

function normalizeModelName(modelName) {
  return modelName.replace(/^models\//, '').trim();
}

async function startAudioCapture() {
  if (!navigator.mediaDevices) {
    throw new Error('当前浏览器不支持 navigator.mediaDevices');
  }

  const sourceMode = els.sourceMode.value;
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (sourceMode === 'display') {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('当前浏览器不支持屏幕/标签页音频采集，请改用麦克风模式');
    }
    state.captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { ideal: 640 }, height: { ideal: 360 } },
      audio: audioConstraints,
    });

    if (state.captureStream.getAudioTracks().length === 0) {
      stopTracks(state.captureStream);
      state.captureStream = null;
      throw new Error('未获得共享音频。请在浏览器分享对话框中勾选音频，或改用麦克风模式');
    }

    for (const track of state.captureStream.getVideoTracks()) {
      track.enabled = false;
    }
  } else {
    state.captureStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: audioConstraints,
    });
  }

  for (const track of state.captureStream.getTracks()) {
    track.addEventListener('ended', () => {
      if (state.isRunning) {
        log(`媒体轨道已结束：${track.kind}`);
        stop({ status: '音频采集已结束', statusType: 'warn' });
      }
    });
  }

  await setupAudioGraph(state.captureStream);
  updateStats();
}

async function setupAudioGraph(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('当前浏览器不支持 Web Audio API');
  }

  state.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
  if (state.audioContext.state === 'suspended') {
    await state.audioContext.resume();
  }

  state.sourceNode = state.audioContext.createMediaStreamSource(stream);
  state.muteNode = state.audioContext.createGain();
  state.muteNode.gain.value = 0;

  const chunkFrameCount = Math.max(320, Math.round(16000 * (Number(els.chunkDuration.value) / 1000)));

  try {
    if (!state.audioContext.audioWorklet) {
      throw new Error('AudioWorklet 不可用');
    }
    await state.audioContext.audioWorklet.addModule('./audio-worklet.js');
    state.workletNode = new AudioWorkletNode(state.audioContext, 'pcm-downsampler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate: 16000,
        chunkFrameCount,
      },
    });
    state.workletNode.port.onmessage = (event) => {
      if (event.data && event.data.type === 'pcm') {
        sendAudioChunk(event.data.buffer);
      }
    };
    state.sourceNode.connect(state.workletNode);
    state.workletNode.connect(state.muteNode).connect(state.audioContext.destination);
    log(`AudioWorklet 采集已启用：${Math.round(state.audioContext.sampleRate)}Hz -> 16000Hz`);
  } catch (error) {
    log(`AudioWorklet 不可用，切换到 ScriptProcessor 兜底：${error.message}`);
    setupScriptProcessorFallback(chunkFrameCount);
  }
}

function setupScriptProcessorFallback(chunkFrameCount) {
  const bufferSize = 4096;
  state.downsampler = new MainThreadDownsampler({
    inputSampleRate: state.audioContext.sampleRate,
    targetSampleRate: 16000,
    chunkFrameCount,
    onChunk: sendAudioChunk,
  });

  state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
  state.scriptProcessor.onaudioprocess = (event) => {
    const inputBuffer = event.inputBuffer;
    const channels = [];
    for (let channelIndex = 0; channelIndex < inputBuffer.numberOfChannels; channelIndex += 1) {
      channels.push(inputBuffer.getChannelData(channelIndex));
    }
    state.downsampler.push(channels);

    const outputBuffer = event.outputBuffer;
    for (let channelIndex = 0; channelIndex < outputBuffer.numberOfChannels; channelIndex += 1) {
      outputBuffer.getChannelData(channelIndex).fill(0);
    }
  };

  state.sourceNode.connect(state.scriptProcessor);
  state.scriptProcessor.connect(state.muteNode).connect(state.audioContext.destination);
  log(`ScriptProcessor 采集已启用：${Math.round(state.audioContext.sampleRate)}Hz -> 16000Hz`);
}

function sendAudioChunk(buffer) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.setupSent) {
    return;
  }
  if (state.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    state.droppedChunks += 1;
    if (state.droppedChunks % 20 === 1) {
      log(`WebSocket 发送缓冲过高，临时丢弃音频块：buffered=${state.ws.bufferedAmount}`);
    }
    updateStats();
    return;
  }

  const message = {
    realtimeInput: {
      audio: {
        data: arrayBufferToBase64(buffer),
        mimeType: 'audio/pcm;rate=16000',
      },
    },
  };

  state.ws.send(JSON.stringify(message));
  state.chunkCount += 1;
  if (state.chunkCount % 50 === 0) {
    log(`已发送 ${state.chunkCount} 个音频块。`);
  }
  updateStats();
}

async function handleServerMessage(event) {
  let text = '';
  if (typeof event.data === 'string') {
    text = event.data;
  } else if (event.data instanceof Blob) {
    text = await event.data.text();
  } else if (event.data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(event.data);
  }

  if (!text) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    log(`无法解析服务端消息：${error.message}`);
    return;
  }

  if (payload.setupComplete) {
    log('Gemini Live setupComplete。');
  }

  const serverContent = payload.serverContent;
  if (!serverContent) {
    return;
  }

  const inputText = serverContent.inputTranscription?.text;
  if (inputText) {
    appendSubtitleText('originalText', inputText);
  }

  const outputText = serverContent.outputTranscription?.text;
  if (outputText) {
    appendSubtitleText('translatedText', outputText);
  }

  const parts = serverContent.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const inlineData = part.inlineData;
      if (inlineData?.mimeType?.startsWith('audio/pcm') && inlineData.data) {
        playPcmAudio(inlineData.data, parsePcmRate(inlineData.mimeType, 24000));
      }
      if (part.text) {
        appendSubtitleText('translatedText', part.text);
      }
    }
  }

  if (serverContent.turnComplete) {
    rotateSubtitleSoon(100);
  }
}

function appendSubtitleText(field, text) {
  state.currentLine[field] += text;
  renderSubtitles();
  if (/[。！？.!?\n]/.test(text)) {
    rotateSubtitleSoon(800);
  }
}

function rotateSubtitleSoon(delay) {
  window.clearTimeout(state.rotateTimer);
  state.rotateTimer = window.setTimeout(() => rotateSubtitle(), delay);
}

function rotateSubtitle() {
  const line = state.currentLine;
  if (!line.originalText.trim() && !line.translatedText.trim()) {
    return;
  }
  state.history.push(line);
  if (state.history.length > MAX_HISTORY) {
    state.history.splice(0, state.history.length - MAX_HISTORY);
  }
  state.currentLine = createSubtitleLine();
  renderSubtitles();
}

function renderSubtitles() {
  const lines = [...state.history];
  const currentHasText = state.currentLine.originalText || state.currentLine.translatedText;
  if (currentHasText) {
    lines.push({ ...state.currentLine, current: true });
  }

  els.subtitleList.replaceChildren();
  els.subtitleList.classList.toggle('empty', lines.length === 0);
  if (lines.length === 0) {
    els.subtitleList.textContent = '等待音频输入…';
    return;
  }

  for (const line of lines) {
    const item = document.createElement('article');
    item.className = `subtitle-line${line.current ? ' current' : ''}`;

    if (els.showBilingual.checked && line.originalText) {
      const original = document.createElement('div');
      original.className = 'subtitle-original';
      original.textContent = line.originalText;
      item.append(original);
    }

    if (line.translatedText) {
      const translated = document.createElement('div');
      translated.className = 'subtitle-translated';
      translated.textContent = line.translatedText;
      item.append(translated);
    }

    els.subtitleList.append(item);
  }
  els.subtitleList.scrollTop = els.subtitleList.scrollHeight;
}

function clearSubtitles() {
  window.clearTimeout(state.rotateTimer);
  state.history = [];
  state.currentLine = createSubtitleLine();
  renderSubtitles();
}

function createSubtitleLine() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    originalText: '',
    translatedText: '',
  };
}

async function playPcmAudio(base64Audio, sampleRate) {
  if (!els.enablePlayback.checked) {
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }
  if (!state.playbackContext) {
    state.playbackContext = new AudioContextClass({ latencyHint: 'interactive' });
  }
  if (state.playbackContext.state === 'suspended') {
    await state.playbackContext.resume();
  }

  const bytes = base64ToUint8Array(base64Audio);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const audioBuffer = state.playbackContext.createBuffer(1, pcm.length, sampleRate);
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < pcm.length; index += 1) {
    const value = pcm[index];
    channel[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }

  const source = state.playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(state.playbackContext.destination);

  const startAt = Math.max(state.playbackContext.currentTime + 0.02, state.playbackTime || 0);
  source.start(startAt);
  state.playbackTime = startAt + audioBuffer.duration;
}

function parsePcmRate(mimeType, fallback) {
  const match = /rate=(\d+)/.exec(mimeType || '');
  return match ? Number(match[1]) : fallback;
}

async function stop({ status = '已停止', statusType = 'idle' } = {}) {
  state.isRunning = false;
  window.clearTimeout(state.rotateTimer);

  try {
    state.workletNode?.port?.postMessage({ type: 'flush' });
  } catch {
    // ignore flush errors during teardown
  }
  state.downsampler?.flush?.();

  disconnectAudioGraph();
  if (state.captureStream) {
    stopTracks(state.captureStream);
    state.captureStream = null;
  }
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'client stop');
    }
  }
  if (state.playbackContext) {
    await state.playbackContext.close().catch(() => {});
    state.playbackContext = null;
    state.playbackTime = 0;
  }
  state.setupSent = false;
  setRunningUi(false);
  setStatus(status, statusType);
  updateStats();
}

function disconnectAudioGraph() {
  for (const node of [state.sourceNode, state.workletNode, state.scriptProcessor, state.muteNode]) {
    try {
      node?.disconnect?.();
    } catch {
      // ignore disconnect errors
    }
  }
  if (state.scriptProcessor) {
    state.scriptProcessor.onaudioprocess = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }
  state.audioContext = null;
  state.sourceNode = null;
  state.workletNode = null;
  state.scriptProcessor = null;
  state.muteNode = null;
  state.downsampler = null;
}

function stopTracks(stream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function setRunningUi(isRunning) {
  els.startButton.disabled = isRunning;
  els.stopButton.disabled = !isRunning;
  els.apiKey.disabled = isRunning;
  els.modelName.disabled = isRunning;
  els.targetLanguage.disabled = isRunning;
  els.sourceMode.disabled = isRunning;
  els.chunkDuration.disabled = isRunning;
}

function setStatus(message, type = 'idle') {
  els.statusText.textContent = message;
  els.statusDot.className = `dot ${type}`;
}

function updateStats() {
  const wsStatus = state.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state.ws.readyState] : '未连接';
  const captureStatus = state.captureStream ? `${state.captureStream.getAudioTracks().length} 条音频轨` : '未启动';
  const dropped = state.droppedChunks ? ` · 丢弃：${state.droppedChunks}` : '';
  els.statsText.textContent = `WebSocket：${wsStatus} · 已发送音频块：${state.chunkCount}${dropped} · 捕获：${captureStatus}`;
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  els.logOutput.textContent += `[${time}] ${message}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
