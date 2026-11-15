/* ============================================================
   Player — front-end logic. Plain ES module, no frameworks.
   ============================================================ */

/* ---------- constants ---------- */

const JOBS_POLL_MS = 1500;
const QUEUE_MODE_KEY = 'queueMode';
const ACTIVE_JOB_STATES = new Set(['queued', 'downloading', 'extracting']);
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  play: ['M8 5v14l11-7z'],
  music: ['M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'],
  movie: ['M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z'],
  trash: ['M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'],
};

/* ---------- state ---------- */

const state = {
  authRequired: false,
  items: [],                 // library, newest first (cached — audio must start without any fetch)
  jobs: [],
  dismissedJobs: new Set(),  // done rows we already removed from the list
  handledJobs: new Set(),    // terminal jobs whose side effects were applied
  currentId: null,           // playing audio item id
  queueMode: loadQueueMode(),
  shuffleOrder: [],          // array of ids
  shufflePos: -1,            // index of current track inside shuffleOrder
  view: 'library',
  seeking: false,
  miniShown: false,
  videoActive: false,
  pollTimer: null,
  retryAfterLogin: null,     // logical action re-run after a successful login
};

/* ---------- dom helpers ---------- */

const $ = (sel) => document.querySelector(sel);

const dom = {};

function cacheDom() {
  dom.views = {
    login: $('#view-login'),
    library: $('#view-library'),
    video: $('#view-video'),
  };
  dom.loginForm = $('#login-form');
  dom.loginToken = $('#login-token');
  dom.loginBtn = $('#login-btn');
  dom.loginError = $('#login-error');
  dom.dlForm = $('#dl-form');
  dom.dlUrl = $('#dl-url');
  dom.dlBtn = $('#dl-btn');
  dom.dlBtnLabel = $('#dl-btn-label');
  dom.dlError = $('#dl-error');
  dom.jobsSection = $('#jobs-section');
  dom.jobsList = $('#jobs-list');
  dom.grid = $('#library-grid');
  dom.libraryEmpty = $('#library-empty');
  dom.btnBack = $('#btn-back');
  dom.videoEl = $('#video');
  dom.videoTitle = $('#video-title');
  dom.videoMeta = $('#video-meta');
  dom.mini = $('#mini-player');
  dom.mpTitle = $('#mp-title');
  dom.mpPlay = $('#mp-play');
  dom.mpPrev = $('#mp-prev');
  dom.mpNext = $('#mp-next');
  dom.mpMode = $('#mp-mode');
  dom.mpModeLabel = $('#mp-mode-label');
  dom.mpSeek = $('#mp-seek');
  dom.mpCur = $('#mp-cur');
  dom.mpDur = $('#mp-dur');
  dom.audio = $('#audio');
  dom.toast = $('#toast');
  audioEl = dom.audio;
}

/** Create an element with attributes; `text:` sets textContent, `on<evt>` adds listeners. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}

function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/* ---------- formatting ---------- */

function fmtTime(seconds) {
  let s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* ---------- toast ---------- */

let toastTimer = null;

function toast(message, ms = 3000) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), ms);
}

/* ---------- api ---------- */

class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    toast('Network error — server unreachable');
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (res.status === 401) {
    stopJobPolling();
    showView('login');
    throw new UnauthorizedError(data && data.error);
  }

  return { status: res.status, ok: res.ok, data };
}

/* ---------- views ---------- */

function showView(name) {
  const previous = state.view;
  if (previous === 'video' && name !== 'video') pauseVideo();
  state.view = name;
  for (const [key, node] of Object.entries(dom.views)) {
    node.hidden = key !== name;
  }
  if (name === 'login') dom.loginToken.focus();
}

/* ---------- auth ---------- */

async function bootstrap() {
  try {
    const { data } = await api('/api/auth-status');
    state.authRequired = Boolean(data && data.auth_required);
  } catch (err) {
    if (err instanceof UnauthorizedError) return; // login shown; login success refreshes
    // network error: stay on the (empty) library view; toast already shown
    return;
  }
  refreshAll();
}

async function refreshAll() {
  await Promise.allSettled([refreshLibrary(), refreshJobs()]);
}

async function submitLogin(ev) {
  ev.preventDefault();
  const token = dom.loginToken.value.trim();
  if (!token) return;
  dom.loginBtn.disabled = true;
  dom.loginError.hidden = true;
  try {
    const { ok, data } = await api('/api/login', { method: 'POST', body: { token } });
    if (ok) {
      dom.loginForm.reset();
      showView('library');
      const retry = state.retryAfterLogin;
      state.retryAfterLogin = null;
      if (retry) retry();
      else refreshAll();
    } else {
      showLoginError('Wrong token — try again.');
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) showLoginError('Wrong token — try again.');
    else showLoginError('Login failed — check your connection.');
  } finally {
    dom.loginBtn.disabled = false;
  }
}

function showLoginError(message) {
  dom.loginError.textContent = message;
  dom.loginError.hidden = false;
}

/* ---------- library ---------- */

function byId(id) {
  return state.items.find((item) => item.id === id);
}

async function refreshLibrary() {
  const { data } = await api('/api/library');
  state.items = Array.isArray(data && data.items) ? data.items : [];
  reconcileShuffleOrder();
  renderLibrary();
}

function renderLibrary() {
  dom.grid.textContent = '';
  for (const item of state.items) dom.grid.append(cardEl(item));
  dom.libraryEmpty.hidden = state.items.length > 0;
  highlightPlayingCard();
}

function cardEl(item) {
  const card = el('article', { class: 'card', 'data-id': item.id });

  // thumbnail (click = play audio)
  const thumb = el('button', {
    class: 'thumb',
    type: 'button',
    'aria-label': `Play audio: ${item.title}`,
    onclick: () => playTrackById(item.id),
  });
  thumb.append(el('img', { src: item.thumb_url, alt: '', loading: 'lazy', decoding: 'async' }));
  if (item.duration) {
    thumb.append(el('span', { class: 'badge', text: fmtTime(item.duration) }));
  }
  const overlay = el('span', { class: 'play-overlay' });
  overlay.append(icon('play'));
  thumb.append(overlay);

  const title = el('button', {
    class: 'card-title',
    type: 'button',
    text: item.title || 'Untitled',
    title: item.title || '',
    onclick: () => playTrackById(item.id),
  });

  const sizeText = fmtSize((item.size_video || 0) + (item.size_audio || 0));
  const meta = el('p', {
    class: 'card-meta',
    text: sizeText ? `${item.uploader || 'Unknown uploader'} · ${sizeText}` : (item.uploader || 'Unknown uploader'),
  });

  const audioBtn = el('button', {
    class: 'btn small primary',
    type: 'button',
    onclick: () => playTrackById(item.id),
  }, icon('music'), el('span', { text: 'Audio' }));
  if (!item.has_audio) audioBtn.disabled = true;

  const videoBtn = el('button', {
    class: 'btn small',
    type: 'button',
    onclick: () => openVideo(item.id),
  }, icon('movie'), el('span', { text: 'Video' }));
  if (!item.has_video) videoBtn.disabled = true;

  const delBtn = el('button', {
    class: 'icon-btn danger',
    type: 'button',
    'aria-label': `Delete: ${item.title}`,
    title: 'Delete',
    onclick: () => deleteItem(item.id),
  }, icon('trash'));

  const actions = el('div', { class: 'card-actions' }, audioBtn, videoBtn, delBtn);
  card.append(thumb, el('div', { class: 'card-body' }, title, meta, actions));
  return card;
}

function highlightPlayingCard() {
  for (const node of dom.grid.children) {
    node.classList.toggle('playing', node.dataset.id === state.currentId);
  }
}

async function deleteItem(id) {
  const item = byId(id);
  if (!item) return;
  if (!window.confirm(`Delete “${item.title}” from the library?`)) return;

  // Optimistic removal; the audio element keeps playing whatever it already has.
  state.items = state.items.filter((entry) => entry.id !== id);
  reconcileShuffleOrder();
  renderLibrary();

  try {
    const { ok, status, data } = await api(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!ok) throw new Error((data && data.error) || `HTTP ${status}`);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      state.retryAfterLogin = () => deleteItem(id);
    } else {
      toast('Could not delete the item');
      try {
        await refreshLibrary();
      } catch {
        /* already surfaced */
      }
    }
  }
}

/* ---------- jobs ---------- */

async function refreshJobs() {
  const { data } = await api('/api/jobs');
  state.jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  processJobs();
  renderJobs();
  if (hasActiveJobs()) startJobPolling();
}

function hasActiveJobs() {
  return state.jobs.some((job) => ACTIVE_JOB_STATES.has(job.state));
}

/** Side effects for jobs that just reached a terminal state. */
function processJobs() {
  for (const job of state.jobs) {
    if (state.handledJobs.has(job.id)) continue;
    if (job.state === 'done') {
      state.handledJobs.add(job.id);
      scheduleLibraryRefreshSoon();
      setTimeout(() => dismissJob(job.id), 2000);
    } else if (job.state === 'error') {
      state.handledJobs.add(job.id);
    }
  }
}

function dismissJob(id) {
  state.dismissedJobs.add(id);
  renderJobs();
}

function startJobPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setTimeout(pollJobsOnce, JOBS_POLL_MS);
}

function stopJobPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function pollJobsOnce() {
  state.pollTimer = null;
  if (!hasActiveJobs()) return;
  try {
    await refreshJobs();
  } catch {
    /* 401 → login shown, polling stopped; network error → toast shown */
  }
}

let libraryRefreshTimer = null;

function scheduleLibraryRefreshSoon() {
  if (libraryRefreshTimer) return;
  libraryRefreshTimer = setTimeout(async () => {
    libraryRefreshTimer = null;
    try {
      await refreshLibrary();
    } catch {
      /* surfaced by api() */
    }
  }, 500);
}

function renderJobs() {
  const visible = state.jobs.filter((job) => !state.dismissedJobs.has(job.id));
  dom.jobsSection.hidden = visible.length === 0;
  dom.jobsList.textContent = '';
  for (const job of visible) dom.jobsList.append(jobEl(job));
}

function jobEl(job) {
  const li = el('li', { class: `job st-${job.state}` });

  const stats = [];
  if (job.state === 'downloading') {
    if (job.progress != null) stats.push(`${Math.round(clamp(job.progress, 0, 100))}%`);
    if (job.speed) stats.push(job.speed);
    if (job.eta) stats.push(`ETA ${job.eta}`);
  }
  const top = el('div', { class: 'job-top' },
    el('span', { class: 'chip', text: job.state }),
    el('span', { class: 'job-title', text: job.title || job.url || job.video_id || 'Download' }),
    stats.length ? el('span', { class: 'job-stats', text: stats.join(' · ') }) : null,
  );
  li.append(top);

  if (job.state === 'downloading' && job.progress != null) {
    li.append(el('div', { class: 'job-bar' },
      el('div', { class: 'job-bar-fill', style: `width:${clamp(job.progress, 0, 100)}%` })));
  }
  if (job.state === 'error' && job.error) {
    li.append(el('p', { class: 'job-error', text: job.error }));
  }
  return li;
}

/* ---------- download ---------- */

function isYoutubeUrl(input) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return url.pathname.replace(/\/+$/, '').length > 1;
  if (host === 'youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.has('v');
    return /^\/(shorts|live)\/[\w-]+/.test(url.pathname);
  }
  return false;
}

async function requestDownload(url) {
  dom.dlBtn.disabled = true;
  dom.dlBtnLabel.textContent = 'Adding…';
  hideDlError();
  try {
    const { status, data } = await api('/api/download', { method: 'POST', body: { url } });
    if (status === 202) {
      dom.dlForm.reset();
      dismissOldErrors();
      await refreshJobs(); // pick the new job up immediately, starts polling
    } else {
      showDlError((data && data.error) || `Download failed (HTTP ${status})`);
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // URL stays in the input; re-submit after login
      state.retryAfterLogin = () => requestDownload(url);
    }
  } finally {
    dom.dlBtn.disabled = false;
    dom.dlBtnLabel.textContent = 'Download';
  }
}

function dismissOldErrors() {
  for (const job of state.jobs) {
    if (job.state === 'error') state.dismissedJobs.add(job.id);
  }
  renderJobs();
}

function showDlError(message) {
  dom.dlError.textContent = message;
  dom.dlError.hidden = false;
}

function hideDlError() {
  dom.dlError.hidden = true;
  dom.dlError.textContent = '';
}

function onSubmitDownload(ev) {
  ev.preventDefault();
  const url = dom.dlUrl.value.trim();
  hideDlError();
  if (!url) return;
  if (!isYoutubeUrl(url)) {
    showDlError('That doesn’t look like a YouTube link (watch page, youtu.be or shorts).');
    return;
  }
  requestDownload(url);
}

/* ---------- video view ---------- */

function openVideo(id) {
  const item = byId(id);
  if (!item) return;
  if (!item.has_video) {
    toast('No video file for this item');
    return;
  }
  dom.videoEl.src = item.video_url;
  dom.videoTitle.textContent = item.title || 'Untitled';
  dom.videoMeta.textContent = [item.uploader, item.duration ? fmtTime(item.duration) : null, fmtSize(item.size_video)]
    .filter(Boolean).join(' · ');
  showView('video');
  const p = dom.videoEl.play(); // inside the user's tap handler
  if (p && p.catch) p.catch(() => { /* user can press play manually */ });
}

function pauseVideo() {
  if (!dom.videoEl.paused) dom.videoEl.pause();
}

/* ============================================================
   Audio engine — single <audio> element, unlocked by the first
   user tap, kept alive for the app's whole lifetime.
   ============================================================ */

let audioEl = null; // set in cacheDom() — the single <audio> element, never recreated

function playTrackById(id, { userGesture = true } = {}) {
  const item = byId(id);
  if (!item) return;
  if (!item.has_audio) {
    toast('No audio available for this item');
    return;
  }
  markCurrentTrack(id);
  loadAudioItem(item);

  // Auto-advance while a video is being watched: queue the track but stay paused.
  if (!userGesture && state.videoActive) {
    updateMiniProgress();
    return;
  }

  pauseVideo();
  // Synchronous on the first user tap: this is what unlocks the element on iOS/Android.
  const p = audioEl.play();
  if (p && p.catch) p.catch(handlePlayRejection);
}

function loadAudioItem(item) {
  state.seeking = false;
  lastReportedPosition = -1;
  audioEl.src = item.audio_url;
  showMiniPlayer();
  dom.mpTitle.textContent = item.title || 'Untitled';
  dom.mpCur.textContent = '0:00';
  dom.mpDur.textContent = '0:00';
  dom.mpSeek.value = '0';
  setSeekFill(0);
  updateMediaSessionMetadata(item);
}

function markCurrentTrack(id) {
  state.currentId = id;
  if (state.queueMode === 'shuffle') {
    let pos = state.shuffleOrder.indexOf(id);
    if (pos === -1) {
      state.shuffleOrder.unshift(id);
      pos = 0;
    }
    state.shufflePos = pos;
  }
  highlightPlayingCard();
}

function togglePlayPause() {
  if (audioEl.paused) {
    if (!state.currentId) {
      const first = firstTrackId();
      if (first == null) {
        toast('Nothing to play yet');
        return;
      }
      playTrackById(first);
      return;
    }
    pauseVideo();
    const p = audioEl.play();
    if (p && p.catch) p.catch(handlePlayRejection);
  } else {
    audioEl.pause();
  }
}

function handlePlayRejection(err) {
  updatePlayPauseUI();
  if (err && err.name === 'NotAllowedError') {
    toast('Tap the play button to start audio');
  }
  // AbortError (src changed mid-play) and similar are fine to ignore.
}

function wireAudioEvents() {
  audioEl.addEventListener('play', () => {
    showMiniPlayer();
    updatePlayPauseUI();
  });
  audioEl.addEventListener('pause', updatePlayPauseUI);
  audioEl.addEventListener('ended', () => {
    // Background auto-advance: same, already-unlocked element. No timers involved.
    const next = nextTrackId();
    if (next != null) playTrackById(next, { userGesture: false });
  });
  audioEl.addEventListener('loadedmetadata', () => {
    dom.mpDur.textContent = fmtTime(audioEl.duration);
    updateMiniProgress();
    updatePositionState();
  });
  audioEl.addEventListener('durationchange', () => {
    dom.mpDur.textContent = fmtTime(audioEl.duration);
  });
  audioEl.addEventListener('timeupdate', () => {
    updateMiniProgress();
    throttledPositionState();
  });
  audioEl.addEventListener('error', () => {
    if (audioEl.getAttribute('src')) toast('Audio playback error');
  });
}

/* ---------- queue ---------- */

function loadQueueMode() {
  try {
    return localStorage.getItem(QUEUE_MODE_KEY) === 'shuffle' ? 'shuffle' : 'sequential';
  } catch {
    return 'sequential';
  }
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Build a fresh shuffled order out of all audible items. */
function ensureShuffleOrder({ keepCurrentFirst = false, avoidFirst = null } = {}) {
  const ids = state.items.filter((item) => item.has_audio).map((item) => item.id);
  shuffleArr(ids);
  if (avoidFirst && ids.length > 1 && ids[0] === avoidFirst) {
    [ids[0], ids[1]] = [ids[1], ids[0]];
  }
  if (keepCurrentFirst && state.currentId && ids.includes(state.currentId)) {
    ids.splice(ids.indexOf(state.currentId), 1);
    ids.unshift(state.currentId);
  }
  state.shuffleOrder = ids;
  state.shufflePos = keepCurrentFirst && state.currentId ? 0 : -1;
}

/** After a library refresh: drop removed ids, splice in new ones (shuffled). */
function reconcileShuffleOrder() {
  const present = new Set(state.items.map((item) => item.id));
  const order = state.shuffleOrder.filter((id) => present.has(id));
  const known = new Set(order);
  const fresh = shuffleArr(state.items.filter((item) => item.has_audio && !known.has(item.id)).map((item) => item.id));
  state.shuffleOrder = order.concat(fresh);
  state.shufflePos = state.currentId ? state.shuffleOrder.indexOf(state.currentId) : state.shufflePos;
  if (state.shufflePos >= state.shuffleOrder.length) state.shufflePos = state.shuffleOrder.length - 1;
}

function firstTrackId() {
  if (state.queueMode === 'shuffle') {
    if (!state.shuffleOrder.length) ensureShuffleOrder();
    return state.shuffleOrder[0] ?? null;
  }
  const first = state.items.find((item) => item.has_audio);
  return first ? first.id : null;
}

function stepSequential(direction) {
  const n = state.items.length;
  if (!n) return null;
  const idx = state.items.findIndex((item) => item.id === state.currentId);
  for (let k = 1; k <= n; k++) {
    const candidate = state.items[((idx + direction * k) % n + n) % n];
    if (candidate && candidate.has_audio) return candidate.id;
  }
  return null;
}

function nextTrackId() {
  if (!state.items.some((item) => item.has_audio)) return null;
  if (state.queueMode === 'shuffle') {
    if (!state.shuffleOrder.length) ensureShuffleOrder();
    let pos = state.shufflePos + 1;
    if (pos >= state.shuffleOrder.length) {
      // everything played — reshuffle and start a new pass
      ensureShuffleOrder({ avoidFirst: state.currentId });
      pos = 0;
    }
    state.shufflePos = pos;
    return state.shuffleOrder[pos] ?? null;
  }
  if (!state.currentId) return firstTrackId();
  return stepSequential(1);
}

function prevTrackId() {
  if (!state.items.some((item) => item.has_audio)) return null;
  if (state.queueMode === 'shuffle') {
    if (!state.shuffleOrder.length) ensureShuffleOrder();
    let pos = state.shufflePos - 1;
    if (pos < 0) pos = state.shuffleOrder.length - 1;
    state.shufflePos = pos;
    return state.shuffleOrder[pos] ?? null;
  }
  if (!state.currentId) return firstTrackId();
  return stepSequential(-1);
}

function userNext() {
  const id = nextTrackId();
  if (id != null) playTrackById(id);
}

function userPrev() {
  const id = prevTrackId();
  if (id != null) playTrackById(id);
}

function setQueueMode(mode) {
  state.queueMode = mode;
  try {
    localStorage.setItem(QUEUE_MODE_KEY, mode);
  } catch {
    /* private mode */
  }
  if (mode === 'shuffle') ensureShuffleOrder({ keepCurrentFirst: true });
  renderModeButton();
}

function toggleQueueMode() {
  setQueueMode(state.queueMode === 'shuffle' ? 'sequential' : 'shuffle');
}

function renderModeButton() {
  const isShuffle = state.queueMode === 'shuffle';
  dom.mpMode.classList.toggle('is-shuffle', isShuffle);
  dom.mpMode.setAttribute('aria-pressed', String(isShuffle));
  dom.mpModeLabel.textContent = isShuffle ? 'Shuffle' : 'Sequential';
}

/* ---------- media session ---------- */

function mediaSession() {
  return 'mediaSession' in navigator ? navigator.mediaSession : null;
}

function updateMediaSessionMetadata(item) {
  const session = mediaSession();
  if (!session || typeof window.MediaMetadata === 'undefined') return;
  try {
    session.metadata = new window.MediaMetadata({
      title: item.title || 'Untitled',
      artist: item.uploader || '',
      album: 'Player',
      artwork: [{ src: item.thumb_url, sizes: '512x512', type: 'image/jpeg' }],
    });
  } catch {
    /* ignore */
  }
}

function updatePositionState() {
  const session = mediaSession();
  if (!session || typeof session.setPositionState !== 'function') return;
  const duration = audioEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    session.setPositionState({
      duration,
      playbackRate: audioEl.playbackRate || 1,
      position: clamp(audioEl.currentTime || 0, 0, duration),
    });
  } catch {
    /* ignore */
  }
}

let lastReportedPosition = -1;

function throttledPositionState() {
  const t = audioEl.currentTime;
  if (Math.abs(t - lastReportedPosition) >= 1) {
    lastReportedPosition = t;
    updatePositionState();
  }
}

function seekAudioTo(time) {
  if (!Number.isFinite(audioEl.duration)) return;
  audioEl.currentTime = clamp(time, 0, audioEl.duration);
  updatePositionState();
  updateMiniProgress();
}

function registerMediaSessionHandlers() {
  const session = mediaSession();
  if (!session) return;
  const on = (action, handler) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      /* action unsupported in this browser */
    }
  };
  on('play', () => {
    pauseVideo();
    const p = audioEl.play();
    if (p && p.catch) p.catch(handlePlayRejection);
  });
  on('pause', () => audioEl.pause());
  on('previoustrack', userPrev);
  on('nexttrack', userNext);
  on('seekto', (details) => {
    if (!details || typeof details.seekTime !== 'number') return;
    if (details.fastSeek && typeof audioEl.fastSeek === 'function') {
      audioEl.fastSeek(details.seekTime);
    } else if (Number.isFinite(audioEl.duration)) {
      audioEl.currentTime = clamp(details.seekTime, 0, audioEl.duration);
    } else {
      audioEl.currentTime = details.seekTime;
    }
    updatePositionState();
    updateMiniProgress();
  });
  on('seekbackward', (details) => seekAudioTo((audioEl.currentTime || 0) - ((details && details.seekOffset) || 10)));
  on('seekforward', (details) => seekAudioTo((audioEl.currentTime || 0) + ((details && details.seekOffset) || 10)));
}

/* ---------- mini-player ---------- */

function showMiniPlayer() {
  if (state.miniShown) return;
  state.miniShown = true;
  dom.mini.classList.add('open');
  document.body.classList.add('has-mini');
}

function updatePlayPauseUI() {
  const playing = !audioEl.paused && !audioEl.ended;
  dom.mpPlay.classList.toggle('is-playing', playing);
  dom.mpPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function setSeekFill(percent) {
  dom.mpSeek.style.setProperty('--fill', `${clamp(percent, 0, 100)}%`);
}

function updateMiniProgress() {
  if (state.seeking) return;
  const duration = audioEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    dom.mpSeek.value = '0';
    setSeekFill(0);
    dom.mpCur.textContent = fmtTime(audioEl.currentTime);
    return;
  }
  const percent = (audioEl.currentTime / duration) * 100;
  dom.mpSeek.value = String(Math.round(percent * 10));
  setSeekFill(percent);
  dom.mpCur.textContent = fmtTime(audioEl.currentTime);
}

function wireMiniPlayer() {
  dom.mpPlay.addEventListener('click', togglePlayPause);
  dom.mpPrev.addEventListener('click', userPrev);
  dom.mpNext.addEventListener('click', userNext);
  dom.mpMode.addEventListener('click', toggleQueueMode);

  dom.mpSeek.addEventListener('input', () => {
    state.seeking = true;
    const percent = dom.mpSeek.value / 10;
    setSeekFill(percent);
    const duration = audioEl.duration;
    dom.mpCur.textContent = fmtTime(Number.isFinite(duration) ? (percent / 100) * duration : 0);
  });
  dom.mpSeek.addEventListener('change', () => {
    state.seeking = false;
    const duration = audioEl.duration;
    if (Number.isFinite(duration) && duration > 0) {
      audioEl.currentTime = (dom.mpSeek.value / 1000) * duration;
      updatePositionState();
    }
    updateMiniProgress();
  });
}

/* ---------- video events ---------- */

function wireVideoEvents() {
  // Mutual exclusion so audio and video never sound at the same time.
  dom.videoEl.addEventListener('play', () => {
    state.videoActive = true;
    if (!audioEl.paused) audioEl.pause();
  });
  dom.videoEl.addEventListener('pause', () => {
    state.videoActive = false;
  });
  dom.videoEl.addEventListener('ended', () => {
    state.videoActive = false;
  });
  dom.videoEl.addEventListener('error', () => {
    if (dom.videoEl.getAttribute('src')) toast('Video playback error');
  });
}

/* ---------- wiring & boot ---------- */

function wireEvents() {
  dom.loginForm.addEventListener('submit', submitLogin);
  dom.dlForm.addEventListener('submit', onSubmitDownload);
  dom.dlUrl.addEventListener('input', hideDlError);
  dom.btnBack.addEventListener('click', () => showView('library'));
  wireAudioEvents();
  wireVideoEvents();
  wireMiniPlayer();
  registerMediaSessionHandlers();
}

function init() {
  cacheDom();
  wireEvents();
  renderModeButton();
  showView('library');
  bootstrap();
}

init();
