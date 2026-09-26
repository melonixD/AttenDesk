function savedUser() {
  try { return JSON.parse(sessionStorage.getItem('attendesk_user') || 'null'); }
  catch { sessionStorage.removeItem('attendesk_user'); return null; }
}
const state = {
  token: sessionStorage.getItem('attendesk_access') || '',
  refresh: sessionStorage.getItem('attendesk_refresh') || '',
  user: savedUser(),
  loginEmail: '',
  registrationEmail: '',
  catalog: null,
  page: 'overview',
  peopleRole: 'student',
  academicEntity: 'branches',
  navigationSequence: 0,
  navigationBusy: false,
  pendingPage: null,
  webBleNearby: null,
  loginMode: 'student',
  liveSession: null,
  rosterFilter: '',
  reportFilters: {},
  correctionFilters: {}
};
let livePollTimer = null;
let refreshInFlight = null;

const ATTENDESK_BLE_SERVICE = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
const ATTENDESK_TOKEN_CHARACTERISTIC = 'd953c2d0-34d8-4d7b-94a7-2f54b42ea6d1';
let cancelActiveBarcodeScan = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const titleCase = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
};
const iconPaths = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
  building: '<path d="M3 21h18M6 21V8l6-4 6 4v13M9 11h.01M9 15h.01M15 11h.01M15 15h.01M11 21v-3h2v3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 16 4-5 3 3 5-7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M6 16c.8-1.3 3.2-1.3 4 0M13 10h5M13 14h4"/>',
  bluetooth: '<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M18 5l2 2M15 8l2 2"/>',
  file: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  alert: '<path d="M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};
function icon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.activity}</svg>`;
}

async function api(path, options = {}, retried = false) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json') && !/\.(xlsx|pdf)(?:\?|$)/.test(path)) {
    throw new Error('The API did not return JSON. Check Vercel routing, server configuration and deployment logs.');
  }
  const payload = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (response.status === 401 && state.refresh && !retried && !path.startsWith('/api/auth/')) {
    if (!refreshInFlight) refreshInFlight = (async () => {
      const refreshed = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refresh }) });
      if (!refreshed.ok) return false;
      const session = await refreshed.json();
      state.token = session.accessToken;
      state.refresh = session.refreshToken;
      sessionStorage.setItem('attendesk_access', state.token);
      sessionStorage.setItem('attendesk_refresh', state.refresh);
      return true;
    })().finally(() => { refreshInFlight = null; });
    if (await refreshInFlight) return api(path, options, true);
  }
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || 'Request failed');
    error.code = payload.error;
    error.status = response.status;
    error.deviceChangeToken = payload.deviceChangeToken;
    throw error;
  }
  return payload;
}

function message(selector, text, error = false) {
  const node = $(selector);
  node.textContent = text;
  node.classList.remove('hidden');
  node.classList.toggle('error', error);
}

function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2200);
}

function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalContent) button.dataset.originalContent = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalContent) {
      button.innerHTML = button.dataset.originalContent;
      delete button.dataset.originalContent;
    }
  }
}

function pageSkeleton() {
  const metricCards = Array.from({ length: 4 }, () => `<div class="skeleton-card"><div class="skeleton-line sm"></div><div class="skeleton-line value"></div><div class="skeleton-line md"></div></div>`).join('');
  const rows = Array.from({ length: 5 }, (_, index) => `<div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line ${index % 2 ? 'md' : 'lg'}"></div><div class="skeleton-line sm"></div></div>`).join('');
  return `<div class="skeleton-layout" aria-label="Loading page"><div class="skeleton-metrics">${metricCards}</div><div class="skeleton-grid"><section class="skeleton-panel"><div class="skeleton-line sm"></div><div class="skeleton-line md"></div><div class="skeleton-table">${rows}</div></section><section class="skeleton-panel"><div class="skeleton-line md"></div><div class="skeleton-line lg"></div><div class="skeleton-block"></div><div class="skeleton-line lg" style="margin-top:18px"></div><div class="skeleton-block"></div></section></div></div>`;
}

function emptyState(title, message, icon = '◇', action = '') {
  return `<div class="empty-state"><div><div class="empty-state-icon">${icon}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${action}</div></div>`;
}

const emptyTableRow = (message, columns) => `<tr><td colspan="${columns}"><div class="empty">${escapeHtml(message)}</div></td></tr>`;

function setRouteProgress(status) {
  const progress = $('#route-progress');
  progress.classList.remove('active', 'done');
  if (status === 'active') requestAnimationFrame(() => progress.classList.add('active'));
  if (status === 'done') progress.classList.add('done');
}

function revealPage() {
  const content = $('#page-content');
  content.classList.remove('page-ready');
  requestAnimationFrame(() => {
    content.classList.add('page-ready');
    animatePageElements(content);
  });
}

function playEntrance(node, keyframes, options) {
  if (motionPreference.matches || typeof node.animate !== 'function') return;
  const animation = node.animate(keyframes, { fill: 'backwards', ...options });
  animation.finished.then(() => animation.cancel()).catch(() => {});
}

function animatePageElements(content) {
  const surfaces = $$('.metric, .panel, .tab-row, .app-callout', content);
  surfaces.slice(0, 12).forEach((node, index) => playEntrance(node, [
    { opacity: 0, transform: 'translate3d(0, 14px, 0) scale(.985)' },
    { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
  ], {
    duration: 520,
    delay: Math.min(index, 8) * 52,
    easing: 'cubic-bezier(.16, 1, .3, 1)'
  }));

  const rows = $$('.data-table tbody tr, .schedule-row, .system-list > div, .action-card', content);
  rows.slice(0, 18).forEach((node, index) => playEntrance(node, [
    { opacity: 0, transform: 'translate3d(-7px, 0, 0)' },
    { opacity: 1, transform: 'translate3d(0, 0, 0)' }
  ], {
    duration: 380,
    delay: 110 + Math.min(index, 12) * 28,
    easing: 'cubic-bezier(.22, 1, .36, 1)'
  }));

  bindInteractiveDepth(content);
  animateMetricValues(content);
  $$('.subject-progress i', content).forEach((bar, index) => playEntrance(bar, [
    { transform: 'scaleX(0)' },
    { transform: 'scaleX(1)' }
  ], { duration: 820, delay: 220 + index * 55, easing: 'cubic-bezier(.16, 1, .3, 1)' }));
}

function animateMetricValues(root) {
  if (motionPreference.matches) return;
  $$('.metric strong', root).forEach((node, index) => {
    const original = node.textContent.trim();
    const match = original.match(/^([\d,.]+)(.*)$/);
    if (!match) return;
    const target = Number(match[1].replaceAll(',', ''));
    if (!Number.isFinite(target)) return;
    const decimals = (match[1].split('.')[1] || '').length;
    const suffix = match[2];
    const padded = /^0\d/.test(match[1]);
    const start = performance.now() + index * 45;
    const duration = 860;
    const draw = now => {
      const progress = Math.max(0, Math.min(1, (now - start) / duration));
      const eased = 1 - Math.pow(1 - progress, 4);
      const value = target * eased;
      let label = decimals ? value.toFixed(decimals) : Math.round(value).toLocaleString('en-IN');
      if (padded && !decimals) label = label.padStart(match[1].length, '0');
      node.textContent = `${label}${suffix}`;
      if (progress < 1) requestAnimationFrame(draw);
      else node.textContent = original;
    };
    requestAnimationFrame(draw);
  });
}

function bindInteractiveDepth(root = document) {
  if (motionPreference.matches || !finePointer.matches) return;
  // Keep cursor-reactive depth on compact decorative cards only. Applying a
  // perspective transform to forms and data tables makes text move beneath the
  // pointer and can cause the cursor to flicker between text and default modes.
  $$('.metric, .action-card, .workspace-chip, .signal-art', root).forEach(surface => {
    if (surface.dataset.depthBound) return;
    surface.dataset.depthBound = 'true';
    surface.classList.add('depth-surface');
    const strength = surface.classList.contains('signal-art') ? 6 : surface.classList.contains('action-card') ? 3.2 : 2.1;
    surface.addEventListener('pointermove', event => {
      const bounds = surface.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      surface.style.setProperty('--surface-rx', `${(0.5 - y) * strength}deg`);
      surface.style.setProperty('--surface-ry', `${(x - 0.5) * strength}deg`);
      surface.style.setProperty('--surface-x', `${x * 100}%`);
      surface.style.setProperty('--surface-y', `${y * 100}%`);
      surface.classList.add('depth-active');
    }, { passive: true });
    surface.addEventListener('pointerleave', () => {
      surface.style.setProperty('--surface-rx', '0deg');
      surface.style.setProperty('--surface-ry', '0deg');
      surface.style.setProperty('--surface-x', '50%');
      surface.style.setProperty('--surface-y', '50%');
      surface.classList.remove('depth-active');
    });
  });
}

let pointerFrame = 0;
let latestPointer = { x: innerWidth / 2, y: innerHeight / 2 };
window.addEventListener('pointermove', event => {
  if (motionPreference.matches || !finePointer.matches) return;
  latestPointer = { x: event.clientX, y: event.clientY };
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    const xRatio = latestPointer.x / innerWidth - 0.5;
    const yRatio = latestPointer.y / innerHeight - 0.5;
    const root = document.documentElement.style;
    root.setProperty('--cursor-x', `${latestPointer.x}px`);
    root.setProperty('--cursor-y', `${latestPointer.y}px`);
    root.setProperty('--parallax-x', `${xRatio * 28}px`);
    root.setProperty('--parallax-y', `${yRatio * 22}px`);
    root.setProperty('--parallax-soft-x', `${xRatio * -10}px`);
    root.setProperty('--parallax-soft-y', `${yRatio * -8}px`);
    pointerFrame = 0;
  });
}, { passive: true });

document.addEventListener('pointerdown', event => {
  if (motionPreference.matches || event.button !== 0) return;
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const bounds = button.getBoundingClientRect();
  const size = Math.max(bounds.width, bounds.height) * 1.45;
  const ripple = document.createElement('span');
  ripple.className = 'press-ripple';
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - bounds.left - size / 2}px`;
  ripple.style.top = `${event.clientY - bounds.top - size / 2}px`;
  button.append(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});

function closeMobileNavigation() {
  $('.sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
  $('#menu-button').setAttribute('aria-expanded', 'false');
}

window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  toast(event.reason?.message || 'The request could not be completed.');
});

function installationId() {
  let id = localStorage.getItem('attendesk_installation');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('attendesk_installation', id);
  }
  return id;
}

function browserDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'phone';
  return `Web Bluetooth · ${platform}`.slice(0, 120);
}

function webBluetoothSupported() {
  return window.isSecureContext && Boolean(navigator.bluetooth?.requestDevice);
}

function showWebDeviceChangeRequest(verificationToken) {
  openModal(`<span class="eyebrow">Registered device</span><h2>Approve this browser</h2><p class="modal-copy">This student account is linked to another phone or browser. Submit a change request for an administrator to approve.</p><form id="web-device-change-form"><label>Reason<input name="reason" required minlength="4" placeholder="New phone, reset browser, or old device unavailable" /></label><button class="primary" type="submit">Request device approval</button></form>`);
  $('#web-device-change-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    setButtonBusy(button, true, 'Sending request…');
    try {
      const response = await fetch('/api/auth/device-change-request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${verificationToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: state.loginEmail, installationId: installationId(), deviceName: browserDeviceName(), reason: new FormData(event.target).get('reason') })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'Could not submit device request');
      closeModal();
      message('#auth-message', 'Device approval requested. Sign in again after an administrator approves this browser.');
    } catch (error) {
      toast(error.message);
    } finally {
      setButtonBusy(button, false);
    }
  }, { once: true });
}

function setLoginMode(mode) {
  state.loginMode = mode;
  $$('[data-login-mode]').forEach(tab => tab.classList.toggle('active', tab.dataset.loginMode === mode));
  $('#student-login-form').classList.toggle('hidden', mode !== 'student');
  $('#student-app-download-panel').classList.toggle('hidden', mode !== 'student');
  $('#staff-login-form').classList.toggle('hidden', mode === 'student');
  $('#request-otp-form').classList.add('hidden');
  $('#verify-otp-form').classList.add('hidden');
  $('#auth-message').classList.add('hidden');
  if (mode !== 'student') $('#staff-identifier').placeholder = mode === 'admin' ? 'melonix' : 'alakh';
}

function storeSession(result) {
  state.token = result.accessToken;
  state.refresh = result.refreshToken;
  state.user = result.user;
  state.page = 'overview';
  sessionStorage.setItem('attendesk_access', state.token);
  sessionStorage.setItem('attendesk_refresh', state.refresh);
  sessionStorage.setItem('attendesk_user', JSON.stringify(state.user));
  showApp();
}

$$('[data-login-mode]').forEach(tab => tab.addEventListener('click', () => setLoginMode(tab.dataset.loginMode)));

$('#android-app-download').addEventListener('click', async event => {
  event.preventDefault();
  const link = event.currentTarget;
  if (link.getAttribute('aria-disabled') === 'true') return;
  const originalContent = link.innerHTML;
  link.setAttribute('aria-disabled', 'true');
  link.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>Preparing download…';
  try {
    const response = await fetch(link.href, { method: 'HEAD', cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('text/html')) throw new Error('APK_NOT_PUBLISHED');
    const download = document.createElement('a');
    download.href = link.href;
    download.download = 'AttenDesk-student.apk';
    document.body.appendChild(download);
    download.click();
    download.remove();
    toast('AttenDesk download started');
  } catch {
    toast('The Android app is being prepared. Please try again after the next deployment.');
  } finally {
    link.removeAttribute('aria-disabled');
    link.innerHTML = originalContent;
  }
});

$('#student-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Signing in…');
  try {
    const result = await api('/api/auth/student-login', {
      method: 'POST',
      body: {
        fullName: $('#student-name').value,
        password: $('#student-password').value,
        rollNumber: $('#student-roll').value,
        clientType: 'web_ble',
        installationId: installationId(),
        deviceName: browserDeviceName(),
        platform: 'web'
      }
    });
    storeSession(result);
  } catch (error) {
    if (error.code === 'DEVICE_CHANGE_REQUIRED' && error.deviceChangeToken) {
      message('#auth-message', 'This account is linked to another phone or browser.', true);
      showWebDeviceChangeRequest(error.deviceChangeToken);
    } else {
      message('#auth-message', error.message, true);
    }
  } finally {
    setButtonBusy(button, false);
  }
});

$('#staff-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Signing in…');
  try {
    storeSession(await api('/api/auth/login', {
      method: 'POST',
      body: { identifier: $('#staff-identifier').value, password: $('#staff-password').value, clientType: 'web' }
    }));
  } catch (error) {
    message('#auth-message', error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
});

$('[data-action="use-otp"]').addEventListener('click', () => {
  $('#staff-login-form').classList.add('hidden');
  $('#request-otp-form').classList.remove('hidden');
});
$('[data-action="use-password"]').addEventListener('click', () => {
  $('#request-otp-form').classList.add('hidden');
  $('#staff-login-form').classList.remove('hidden');
});

$('#request-otp-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Sending code…');
  state.loginEmail = $('#login-email').value.trim().toLowerCase();
  try {
    const result = await api('/api/auth/request-otp', { method: 'POST', body: { email: state.loginEmail } });
    $('#request-otp-form').classList.add('hidden');
    $('#verify-otp-form').classList.remove('hidden');
    if (result.developmentOtp) $('#login-otp').value = result.developmentOtp;
    message('#auth-message', result.developmentOtp ? `Development code: ${result.developmentOtp}` : 'Code sent to your college email.');
  } catch (error) {
    message('#auth-message', error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
});

$('#verify-otp-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Verifying…');
  try {
    const result = await api('/api/auth/verify-otp', {
      method: 'POST',
      body: { email: state.loginEmail, code: $('#login-otp').value, clientType: state.loginMode === 'student' ? 'web_ble' : 'web', installationId: installationId(), deviceName: browserDeviceName(), platform: 'web' }
    });
    storeSession(result);
  } catch (error) {
    if (error.code === 'DEVICE_CHANGE_REQUIRED' && error.deviceChangeToken) {
      message('#auth-message', 'This student account is linked to another registered device.', true);
      showWebDeviceChangeRequest(error.deviceChangeToken);
    } else {
      message('#auth-message', error.message, true);
    }
  } finally {
    setButtonBusy(button, false);
  }
});

$('[data-action="change-email"]').addEventListener('click', () => {
  $('#request-otp-form').classList.remove('hidden');
  $('#verify-otp-form').classList.add('hidden');
  $('#auth-message').classList.add('hidden');
});
$('[data-action="open-register"]').addEventListener('click', () => { $('#login-card').classList.add('hidden'); $('#register-card').classList.remove('hidden'); });
$('[data-action="back-login"]').addEventListener('click', () => { $('#register-card').classList.add('hidden'); $('#login-card').classList.remove('hidden'); });

$('#register-role').addEventListener('change', event => {
  $('#student-fields').classList.toggle('hidden', event.target.value !== 'student');
  $('#teacher-fields').classList.toggle('hidden', event.target.value !== 'teacher');
});

$('[data-action="load-college"]').addEventListener('click', async () => {
  const button = $('[data-action="load-college"]');
  const email = $('#register-email').value.trim();
  if (!email) return message('#register-message', 'Enter your college email first.', true);
  setButtonBusy(button, true, 'Loading college…');
  try {
    state.catalog = await api(`/api/public/catalog?email=${encodeURIComponent(email)}`);
    const branches = state.catalog.branches.map(item => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('');
    $('#register-branch').innerHTML = branches;
    $('#teacher-branch').innerHTML = `<option value="">Not assigned</option>${branches}`;
    $('#register-semester').innerHTML = state.catalog.semesters.map(item => `<option value="${item.id}">Semester ${item.number} · ${escapeHtml(item.academic_year)}</option>`).join('');
    refreshRegistrationSections();
    message('#register-message', `${state.catalog.organization.name} options loaded.`);
  } catch (error) {
    message('#register-message', error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
});

function refreshRegistrationSections() {
  if (!state.catalog) return;
  const branch = $('#register-branch').value;
  const semester = $('#register-semester').value;
  const matching = state.catalog.sections.filter(item => item.branch_id === branch && item.semester_id === semester);
  $('#register-section').innerHTML = matching.map(item => `<option value="${item.id}">Section ${escapeHtml(item.name)}</option>`).join('') || '<option value="">No section configured</option>';
}
$('#register-branch').addEventListener('change', refreshRegistrationSections);
$('#register-semester').addEventListener('change', refreshRegistrationSections);

$('#registration-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Sending code…');
  const form = new FormData(event.target);
  const role = form.get('role');
  const body = Object.fromEntries(form.entries());
  if (role === 'teacher') body.branchId = body.teacherBranchId || null;
  delete body.teacherBranchId;
  try {
    state.registrationEmail = String(body.email).trim().toLowerCase();
    const result = await api('/api/auth/register', { method: 'POST', body });
    $('#registration-form').classList.add('hidden');
    $('#registration-otp-form').classList.remove('hidden');
    if (result.developmentOtp) $('#registration-otp').value = result.developmentOtp;
    message('#register-message', result.developmentOtp ? `Development code: ${result.developmentOtp}` : 'Verification code sent.');
  } catch (error) {
    message('#register-message', error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
});

$('#registration-otp-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Submitting request…');
  try {
    const result = await api('/api/auth/verify-registration', { method: 'POST', body: { email: state.registrationEmail, code: $('#registration-otp').value } });
    message('#register-message', result.message);
    event.target.classList.add('hidden');
  } catch (error) {
    message('#register-message', error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
});

const navByRole = {
  admin: [
    ['overview', 'home', 'Overview'], ['registrations', 'check', 'Approvals'], ['people', 'users', 'People'], ['academic', 'building', 'Academic setup'], ['courses', 'book', 'Courses'], ['timetable', 'calendar', 'Timetable'], ['bulk-import', 'file', 'Bulk import'], ['corrections', 'check', 'Corrections'], ['classrooms', 'building', 'Rooms & beacons'], ['devices', 'phone', 'Device requests'], ['reports', 'chart', 'Reports'], ['security', 'shield', 'Security & backups']
  ],
  teacher: [['overview', 'home', 'Overview'], ['classes', 'book', 'Take attendance'], ['reports', 'chart', 'Attendance reports']],
  student: [['overview', 'chart', 'My attendance']]
};

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#profile-name').textContent = state.user.full_name;
  $('#profile-role').textContent = state.user.role;
  $('#profile-avatar').textContent = state.user.full_name.split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
  $('#current-date').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
  $('#menu-button').innerHTML = icon('menu', 19);
  $('#nav').innerHTML = navByRole[state.user.role].map(([page, iconName, label]) => `<button class="nav-button ${page === state.page ? 'active' : ''}" data-page="${page}"><span>${icon(iconName, 17)}</span>${label}</button>`).join('') + `<button class="nav-button logout-button" data-action="logout"><span>${icon('logout', 17)}</span>Log out</button>`;
  navigate(state.page);
}

async function navigate(page) {
  if (state.navigationBusy) {
    state.pendingPage = page;
    return;
  }
  state.navigationBusy = true;
  const navigationId = ++state.navigationSequence;
  state.page = page;
  if (page !== 'live') stopLivePolling();
  $$('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  closeMobileNavigation();
  const content = $('#page-content');
  content.classList.remove('page-ready');
  content.setAttribute('aria-busy', 'true');
  content.innerHTML = pageSkeleton();
  setRouteProgress('active');
  try {
    if (state.user.role === 'admin') await renderAdminPage(page);
    else if (state.user.role === 'teacher') await renderTeacherPage(page);
    else await renderStudentPage();
    if (navigationId !== state.navigationSequence) return;
    revealPage();
  } catch (error) {
    if (navigationId !== state.navigationSequence) return;
    content.innerHTML = `<article class="panel">${emptyState('Could not load this page', error.message || 'Check your connection and try again.', '!', `<button class="table-action" data-retry-page="${escapeHtml(page)}">Try again</button>`)}</article>`;
    revealPage();
  } finally {
    if (navigationId === state.navigationSequence) {
      content.removeAttribute('aria-busy');
      setRouteProgress('done');
    }
    state.navigationBusy = false;
    const pendingPage = state.pendingPage;
    state.pendingPage = null;
    if (pendingPage && pendingPage !== page) queueMicrotask(() => navigate(pendingPage));
  }
}

function heading(eyebrow, title) {
  $('#page-eyebrow').textContent = eyebrow;
  $('#page-title').textContent = title;
  document.title = `${title} · AttenDesk`;
}

async function renderAdminPage(page) {
  if (page === 'overview') return renderAdminOverview();
  if (page === 'registrations') return renderRegistrations();
  if (page === 'people') return renderPeople();
  if (page === 'academic') return renderAcademic();
  if (page === 'courses') return renderCourses();
  if (page === 'timetable') return renderTimetable();
  if (page === 'bulk-import') return renderBulkImport();
  if (page === 'corrections') return renderCorrections();
  if (page === 'classrooms') return renderClassrooms();
  if (page === 'devices') return renderDevices();
  if (page === 'reports') return renderReports();
  if (page === 'security') return renderSecurity();
}

async function renderAdminOverview() {
  heading('Administration', 'College overview');
  const data = await api('/api/admin/overview');
  const setupSteps = [
    { label: 'Academic structure', note: 'Add a branch, semester, section and subject', complete: Number(data.branches) > 0 && Number(data.semesters) > 0 && Number(data.sections) > 0 && Number(data.subjects) > 0, page: 'academic' },
    { label: 'Teacher accounts', note: 'Create at least one teacher with login credentials', complete: Number(data.teachers) > 0, page: 'people', peopleRole: 'teacher' },
    { label: 'Student accounts', note: 'Create or import students and register barcodes', complete: Number(data.students) > 0, page: 'people', peopleRole: 'student' },
    { label: 'Course allocation', note: 'Assign subject, teacher and section', complete: Number(data.offerings) > 0, page: 'courses' },
    { label: 'Classroom', note: 'Register the room used for attendance', complete: Number(data.classrooms) > 0, page: 'classrooms' },
    { label: 'ESP32 beacon', note: 'Provision and flash a beacon when hardware arrives', complete: Number(data.beacons) > 0, page: 'classrooms', optional: true }
  ];
  const requiredSteps = setupSteps.filter(step => !step.optional);
  const completedSteps = requiredSteps.filter(step => step.complete).length;
  $('#page-content').innerHTML = `
    <section class="metrics">
      ${metric(data.students, 'Students', 'Active academic records', true)}${metric(data.teachers, 'Teachers', 'Approved faculty')}${metric(data.registrations, 'Pending accounts', 'Needs review')}${metric(data.sessions_today, 'Sessions today', 'Across all classes')}
    </section>
    <article class="panel setup-panel">
      <div class="panel-header"><div><span class="eyebrow">First-time setup</span><h2>Make Attendesk ready for a real class</h2></div><span class="pill ${completedSteps === requiredSteps.length ? '' : 'warn'}">${completedSteps}/${requiredSteps.length} required steps</span></div>
      <div class="setup-progress"><i style="width:${Math.round((completedSteps / requiredSteps.length) * 100)}%"></i></div>
      <div class="setup-grid">${setupSteps.map((step, index) => `<button class="setup-step ${step.complete ? 'complete' : ''}" data-page="${step.page}" ${step.peopleRole ? `data-setup-people="${step.peopleRole}"` : ''}><span>${step.complete ? icon('check', 16) : String(index + 1)}</span><div><strong>${escapeHtml(step.label)}${step.optional ? ' · optional' : ''}</strong><small>${escapeHtml(step.note)}</small></div><i>${icon('arrow', 15)}</i></button>`).join('')}</div>
    </article>
    <section class="split">
      <article class="panel"><div class="panel-header"><div><span class="eyebrow">Attention queue</span><h2>Tasks waiting for you</h2></div><span class="pill warn">${Number(data.registrations) + Number(data.device_requests)} pending</span></div>
        <div class="action-grid"><button class="action-card" data-page="registrations"><span class="action-icon">${icon('check')}</span><span><strong>${data.registrations} registration requests</strong><small>Verify student and teacher details</small></span><i>${icon('arrow',15)}</i></button><button class="action-card" data-page="devices"><span class="action-icon">${icon('phone')}</span><span><strong>${data.device_requests} device changes</strong><small>Review phone replacement requests</small></span><i>${icon('arrow',15)}</i></button><button class="action-card" data-page="academic"><span class="action-icon">${icon('building')}</span><span><strong>Academic structure</strong><small>Branches, subjects and semesters</small></span><i>${icon('arrow',15)}</i></button></div>
      </article>
      <article class="panel"><div class="panel-header"><div><span class="eyebrow">System</span><h2>Production controls</h2></div><span class="pill">All systems ready</span></div><div class="system-list"><div><span>${icon('shield',16)}</span><div><strong>College OTP</strong><small>Passwordless authentication active</small></div><i>Active</i></div><div><span>${icon('file',16)}</span><div><strong>Audit trail</strong><small>Administrative changes recorded</small></div><i>Active</i></div><div><span>${icon('database',16)}</span><div><strong>PostgreSQL</strong><small>Persistent attendance storage</small></div><i>Active</i></div></div></article>
    </section>`;
}

function metric(value, label, note, dark = false) {
  const metricIcons = { Students: 'users', Teachers: 'user', 'Pending accounts': 'check', 'Sessions today': 'calendar', 'Assigned classes': 'book', 'Required attendance': 'chart', 'Attendance method': 'bluetooth', 'Roster updates': 'activity', 'Overall attendance': 'chart', Subjects: 'book', 'Below threshold': 'alert', 'Marking access': 'phone', Login: 'shield', 'Access token': 'key', 'Audit events': 'file', Backups: 'database' };
  return `<article class="metric ${dark ? 'dark' : ''}"><div class="metric-top"><span>${escapeHtml(label)}</span><i>${icon(metricIcons[label] || 'activity', 17)}</i></div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

async function renderRegistrations() {
  heading('Approvals', 'Account registrations');
  const rows = await api('/api/admin/registrations');
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">Identity review</span><h2>Student and teacher requests</h2></div><span class="pill warn">${rows.filter(row => row.status === 'pending_approval').length} pending</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Applicant</th><th>Role</th><th>Details</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><div class="person"><span class="person-avatar">${escapeHtml(row.full_name[0])}</span><div><strong>${escapeHtml(row.full_name)}</strong><br /><small>${escapeHtml(row.email)}</small></div></div></td><td>${titleCase(row.requested_role)}</td><td>${escapeHtml(row.details.rollNumber || row.details.employeeCode || '—')}</td><td><span class="pill ${row.status === 'pending_approval' ? 'warn' : ''}">${titleCase(row.status)}</span></td><td>${row.status === 'pending_approval' ? `<button class="table-action" data-approve-registration="${row.id}">Approve</button> <button class="table-action danger" data-reject-registration="${row.id}">Reject</button>` : '—'}</td></tr>`).join('') || emptyTableRow('No registration requests yet.', 5)}</tbody></table></div></article>`;
}

async function renderPeople() {
  heading('Directory', 'People and credentials');
  const rows = await api(`/api/admin/people?role=${state.peopleRole}`);
  $('#page-content').innerHTML = `<div class="tab-row"><button class="tab ${state.peopleRole === 'student' ? 'active' : ''}" data-people-role="student">Students</button><button class="tab ${state.peopleRole === 'teacher' ? 'active' : ''}" data-people-role="teacher">Teachers</button></div><article class="panel"><div class="panel-header"><div><span class="eyebrow">Approved accounts</span><h2>${titleCase(state.peopleRole)} directory</h2></div><div class="panel-actions"><button class="secondary compact" data-open-import="${state.peopleRole}s">Import CSV</button><button class="primary compact" data-add-person="${state.peopleRole}">Add ${state.peopleRole}</button><span class="pill">${rows.length} records</span></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Person</th><th>Identifier</th><th>Academic assignment</th><th>${state.peopleRole === 'student' ? 'ID and device' : 'Status'}</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><div class="person"><span class="person-avatar">${escapeHtml(row.full_name[0])}</span><div><strong>${escapeHtml(row.full_name)}</strong><br /><small>${escapeHtml(row.email)}</small></div></div></td><td>${escapeHtml(row.roll_number || row.employee_code)}</td><td>${escapeHtml([row.branch, row.semester && `Sem ${row.semester}`, row.section && `Section ${row.section}`].filter(Boolean).join(' · ') || '—')}</td><td>${state.peopleRole === 'student' ? `${row.barcode_status ? `Barcode ••••${escapeHtml(row.barcode_last_four)}` : '<span class="warning-text">No barcode</span>'}<br /><small>${escapeHtml(row.device_name || 'No device')} · ${titleCase(row.status)}</small>` : titleCase(row.status)}</td><td>${state.peopleRole === 'student' ? `<button class="table-action" data-register-barcode="${row.id}" data-student-name="${escapeHtml(row.full_name)}">Barcode</button> ` : ''}<button class="table-action" data-reset-user-password="${row.id}" data-user-name="${escapeHtml(row.full_name)}">Password</button> <button class="table-action ${row.status==='active'?'danger':''}" data-user-status="${row.id}" data-current-status="${row.status}">${row.status==='active'?'Suspend':'Reactivate'}</button></td></tr>`).join('') || emptyTableRow(`No ${state.peopleRole}s yet. Use the Add ${state.peopleRole} button to create one.`, 5)}</tbody></table></div></article>`;
}

async function renderAcademic() {
  heading('Academic setup', 'College structure');
  const entity = state.academicEntity;
  const rows = entity === 'sections' ? await api('/api/admin/sections') : await api(`/api/admin/academic/${entity}`);
  const catalogs = await Promise.all([api('/api/admin/academic/branches'), api('/api/admin/academic/semesters')]);
  const form = academicForm(entity, catalogs[0], catalogs[1]);
  $('#page-content').innerHTML = `<div class="tab-row">${['branches','semesters','subjects','sections'].map(item => `<button class="tab ${item === entity ? 'active' : ''}" data-academic="${item}">${titleCase(item)}</button>`).join('')}</div><article class="panel"><div class="panel-header"><div><span class="eyebrow">Create and manage</span><h2>${titleCase(entity)}</h2></div><div class="panel-actions">${entity === 'subjects' ? '<button class="secondary compact" data-open-import="subjects">Import subjects</button>' : ''}<span class="pill">${rows.length} configured</span></div></div>${form}</article><article class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Code / period</th><th>Assignment</th><th>Status</th><th>Manage</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.name || `Semester ${row.number}`)}</strong></td><td>${escapeHtml(row.code || (row.academic_year ? `${row.academic_year} · ${row.term}` : '—'))}</td><td>${escapeHtml([row.branch_name, row.semester_number && `Semester ${row.semester_number}`].filter(Boolean).join(' · ') || '—')}</td><td><span class="pill">${row.active === false ? 'Inactive' : 'Active'}</span></td><td><button class="table-action" data-edit-academic="${row.id}" data-entity="${entity}">Edit</button> <button class="table-action" data-toggle-academic="${row.id}" data-entity="${entity}" data-active="${row.active !== false}">${row.active === false ? 'Activate' : 'Deactivate'}</button></td></tr>`).join('') || emptyTableRow(`No ${entity} configured yet.`, 5)}</tbody></table></div></article>`;
}

function academicForm(entity, branches, semesters) {
  if (entity === 'branches') return `<form class="compact-form" data-create-academic="branches"><label>Branch code<input name="code" placeholder="FT" required /></label><label>Branch name<input name="name" placeholder="Food Technology" required /></label><button class="primary">Add branch</button></form>`;
  if (entity === 'subjects') return `<form class="compact-form" data-create-academic="subjects"><label>Subject code<input name="code" placeholder="FT-201" required /></label><label>Subject name<input name="name" required /></label><label>Credits<input name="credits" type="number" min="0" step="0.5" value="4" /></label><button class="primary">Add subject</button></form>`;
  if (entity === 'semesters') return `<form class="compact-form" data-create-academic="semesters"><label>Semester number<input name="number" type="number" min="1" max="12" required /></label><label>Academic year<input name="academic_year" placeholder="2026-27" required /></label><label>Term<select name="term"><option>odd</option><option>even</option><option>summer</option></select></label><label>Starts on<input name="starts_on" type="date" required /></label><label>Ends on<input name="ends_on" type="date" required /></label><button class="primary">Add semester</button></form>`;
  return `<form class="compact-form" data-create-section><label>Branch<select name="branchId">${branches.map(row => `<option value="${row.id}">${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId">${semesters.map(row => `<option value="${row.id}">Semester ${row.number} · ${escapeHtml(row.academic_year)}</option>`).join('')}</select></label><label>Section name<input name="name" placeholder="A" required /></label><button class="primary">Add section</button></form>`;
}

async function renderCourses() {
  heading('Course allocation', 'Subjects, teachers and enrollments');
  const [offerings, subjects, teachers, sections, semesters, students] = await Promise.all([
    api('/api/admin/offerings'), api('/api/admin/academic/subjects'), api('/api/admin/people?role=teacher'),
    api('/api/admin/sections'), api('/api/admin/academic/semesters'), api('/api/admin/people?role=student')
  ]);
  const courseOptions = offerings.map(row => `<option value="${row.id}">${escapeHtml(row.subject)} · ${escapeHtml(row.branch)} ${escapeHtml(row.section)}</option>`).join('');
  const canCreateCourse = subjects.some(row => row.active) && teachers.length && sections.some(row => row.active) && semesters.some(row => row.active);
  const canEnroll = offerings.length && students.length;
  $('#page-content').innerHTML = `<section class="split"><article class="panel"><div class="panel-header"><div><span class="eyebrow">New course</span><h2>Assign a subject</h2></div></div>${canCreateCourse ? `<form class="compact-form" data-create-offering><label>Subject<select name="subjectId">${subjects.filter(row=>row.active).map(row=>`<option value="${row.id}">${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Teacher<select name="teacherId">${teachers.map(row=>`<option value="${row.id}">${escapeHtml(row.full_name)}</option>`).join('')}</select></label><label>Section<select name="sectionId">${sections.filter(row=>row.active).map(row=>`<option value="${row.id}">${escapeHtml(row.branch_code)} · Sem ${row.semester_number} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId">${semesters.filter(row=>row.active).map(row=>`<option value="${row.id}">Semester ${row.number} · ${escapeHtml(row.academic_year)}</option>`).join('')}</select></label><label>Default room<input name="defaultRoom" placeholder="210" required /></label><button class="primary">Create course</button></form>` : `<div class="dependency-note"><strong>Complete the prerequisites first.</strong><p>You need an active subject, teacher, semester and section before creating a course.</p><button class="table-action" data-page="academic">Open academic setup</button> <button class="table-action" data-page="people" data-setup-people="teacher">Add teacher</button></div>`}</article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Roster</span><h2>Enroll a student</h2></div></div>${canEnroll ? `<form class="compact-form" data-enroll-student><label>Course<select name="offeringId">${courseOptions}</select></label><label>Student<select name="studentId">${students.map(row=>`<option value="${row.id}">${escapeHtml(row.roll_number)} · ${escapeHtml(row.full_name)}</option>`).join('')}</select></label><button class="primary">Add to roster</button></form>` : `<div class="dependency-note"><strong>${offerings.length ? 'Create or import students.' : 'Create a course first.'}</strong><p>Students can be enrolled after both the course and student account exist.</p><button class="table-action" data-page="people" data-setup-people="student">Open students</button></div>`}</article></section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Current semester</span><h2>Course offerings</h2></div><div class="panel-actions"><button class="secondary compact" data-open-import="courses">Import courses</button><button class="secondary compact" data-open-import="enrollments">Import enrollments</button><span class="pill">${offerings.length} courses</span></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Teacher</th><th>Class</th><th>Semester</th><th>Room</th><th>Manage</th></tr></thead><tbody>${offerings.map(row=>`<tr><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.subject_code)}</small></td><td>${escapeHtml(row.teacher)}</td><td>${escapeHtml(row.branch)} · Section ${escapeHtml(row.section)}</td><td>${row.semester}</td><td>${escapeHtml(row.default_room)}</td><td><button class="table-action" data-view-roster="${row.id}" data-course-name="${escapeHtml(row.subject)}">${row.enrolled_students || 0} students</button> <button class="table-action" data-edit-offering="${row.id}">Edit</button></td></tr>`).join('') || emptyTableRow('No courses yet. Complete the setup cards above.', 6)}</tbody></table></div></article>`;
}

async function renderTimetable() {
  heading('Scheduling', 'Timetable management');
  const [entries, offerings] = await Promise.all([api('/api/admin/timetable'), api('/api/admin/offerings')]);
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">New class period</span><h2>Add timetable entry</h2></div><button class="secondary compact" data-open-import="timetables">Import timetable</button></div><form class="compact-form" id="timetable-form"><label>Class<select name="offeringId">${offerings.map(row => `<option value="${row.id}">${escapeHtml(row.subject)} · ${escapeHtml(row.branch)} ${escapeHtml(row.section)}</option>`).join('')}</select></label><label>Day<select name="dayOfWeek">${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day,index)=>`<option value="${index+1}">${day}</option>`).join('')}</select></label><label>Room<input name="room" required /></label><label>Starts<input name="startsAt" type="time" required /></label><label>Ends<input name="endsAt" type="time" required /></label><label>Valid from<input name="validFrom" type="date" required /></label><label>Valid until<input name="validUntil" type="date" required /></label><button class="primary">Add period</button></form></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Weekly plan</span><h2>Configured periods</h2></div><span class="pill">${entries.length} entries</span></div>${entries.map(row=>`<div class="schedule-row timetable-row"><span class="day">${['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'][row.day_of_week]}</span><strong>${escapeHtml(row.subject)}</strong><span>${escapeHtml(row.branch)} · ${escapeHtml(row.section)}</span><span>${String(row.starts_at).slice(0,5)}–${String(row.ends_at).slice(0,5)}</span><span><button class="table-action" data-edit-period="${row.id}">Edit</button> <button class="table-action danger" data-delete-period="${row.id}">Remove</button></span></div>`).join('') || '<div class="empty">No timetable entries yet.</div>'}</article>`;
}

async function renderBulkImport() {
  heading('Administration', 'Bulk import centre');
  const order = ['students', 'teachers', 'subjects', 'courses', 'enrollments', 'timetables'];
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">CSV onboarding</span><h2>Upload college data in the correct order</h2></div><span class="pill">Up to 1,000 rows per file</span></div><p class="modal-copy">Download a ready-made template, fill it in Excel or Google Sheets, save as CSV, then upload it here. Invalid rows are reported with their exact row number.</p><div class="import-grid">${order.map((key, index) => { const item = importDefinitions[key]; return `<button class="import-card" data-open-import="${key}"><span>${index + 1}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small></div>${icon('arrow', 16)}</button>`; }).join('')}</div></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Safe workflow</span><h2>Recommended import sequence</h2></div></div><div class="system-list"><div><span>${icon('building',16)}</span><div><strong>1. Academic structure</strong><small>Create branches, semesters and sections manually; then import subjects.</small></div></div><div><span>${icon('users',16)}</span><div><strong>2. People</strong><small>Import teachers and students before allocating courses.</small></div></div><div><span>${icon('calendar',16)}</span><div><strong>3. Allocation</strong><small>Import courses, enrollments, then timetable periods.</small></div></div></div></article>`;
}

function correctionQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.correctionFilters)) if (value) params.set(key, value);
  return params.toString();
}

async function renderCorrections() {
  heading('Attendance control', 'Corrections and appeals');
  const query = correctionQuery();
  const [sessions, appeals, branches, semesters, sections, subjects] = await Promise.all([
    api(`/api/admin/attendance/sessions${query ? `?${query}` : ''}`), api('/api/admin/attendance/appeals?status=pending'),
    api('/api/admin/academic/branches'), api('/api/admin/academic/semesters'), api('/api/admin/sections'), api('/api/admin/academic/subjects')
  ]);
  const selected = (key, value) => String(state.correctionFilters[key] || '') === String(value) ? 'selected' : '';
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">Find a completed class</span><h2>Post-session correction</h2></div><span class="pill warn">${appeals.length} pending appeals</span></div><form class="filter-form" id="correction-filter-form"><label>Branch<select name="branchId"><option value="">All branches</option>${branches.map(row=>`<option value="${row.id}" ${selected('branchId',row.id)}>${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId"><option value="">All semesters</option>${semesters.map(row=>`<option value="${row.id}" ${selected('semesterId',row.id)}>Semester ${row.number} · ${escapeHtml(row.academic_year)}</option>`).join('')}</select></label><label>Section<select name="sectionId"><option value="">All sections</option>${sections.map(row=>`<option value="${row.id}" ${selected('sectionId',row.id)}>${escapeHtml(row.branch_code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Subject<select name="subjectId"><option value="">All subjects</option>${subjects.map(row=>`<option value="${row.id}" ${selected('subjectId',row.id)}>${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>From<input name="from" type="date" value="${escapeHtml(state.correctionFilters.from || '')}" /></label><label>To<input name="to" type="date" value="${escapeHtml(state.correctionFilters.to || '')}" /></label><button class="primary compact">Apply filters</button><button class="secondary compact" type="button" data-clear-correction-filters>Clear</button></form></article><section class="split"><article class="panel"><div class="panel-header"><div><span class="eyebrow">Student requests</span><h2>Pending appeals</h2></div></div>${appeals.map(row=>`<div class="appeal-row"><div><strong>${escapeHtml(row.full_name)}</strong><small>${escapeHtml(row.roll_number)} · ${escapeHtml(row.subject_code)} · ${new Date(row.starts_at).toLocaleDateString()}</small><p>${escapeHtml(row.reason)}</p></div><div><span class="pill warn">${titleCase(row.current_status)} → ${titleCase(row.requested_status)}</span><button class="table-action" data-review-appeal="${row.id}" data-appeal-student="${escapeHtml(row.full_name)}" data-requested-status="${row.requested_status}">Review</button></div></div>`).join('') || '<div class="empty">No attendance appeals are waiting.</div>'}</article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Completed windows</span><h2>Sessions</h2></div><span class="pill">${sessions.length}</span></div>${sessions.map(row=>`<div class="appeal-row"><div><strong>${escapeHtml(row.subject)} · ${escapeHtml(row.branch)} ${escapeHtml(row.section)}</strong><small>${new Date(row.starts_at).toLocaleString()} · Room ${escapeHtml(row.room)} · ${escapeHtml(row.teacher)}</small></div><div><span>${row.present}/${row.recorded} present</span><button class="table-action" data-open-correction="${row.id}">Open roster</button></div></div>`).join('') || '<div class="empty">No completed sessions match these filters.</div>'}</article></section>`;
}

async function renderDevices() {
  heading('Device security', 'Phone change requests');
  const rows = await api('/api/admin/device-change-requests');
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">One phone per student</span><h2>Replacement approvals</h2></div><span class="pill warn">${rows.filter(row=>row.status==='pending').length} pending</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Current phone</th><th>Requested phone</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.roll_number)}</small></td><td>${escapeHtml(row.old_device_name || 'None')}</td><td>${escapeHtml(row.requested_device_name)}</td><td>${escapeHtml(row.reason)}</td><td>${row.status==='pending'?`<button class="table-action" data-approve-device="${row.id}">Approve</button> <button class="table-action danger" data-reject-device="${row.id}">Reject</button>`:`<span class="pill">${titleCase(row.status)}</span>`}</td></tr>`).join('') || emptyTableRow('No device-change requests.', 5)}</tbody></table></div></article>`;
}

async function renderReports() {
  heading('Attendance intelligence', 'Reports and defaulters');
  const admin = state.user.role === 'admin';
  const [allOfferings, branches, semesters, sections, subjects] = await Promise.all([
    admin ? api('/api/admin/offerings') : api('/api/teacher/classes'),
    admin ? api('/api/admin/academic/branches') : [], admin ? api('/api/admin/academic/semesters') : [],
    admin ? api('/api/admin/sections') : [], admin ? api('/api/admin/academic/subjects') : []
  ]);
  const f = state.reportFilters;
  const offerings = allOfferings.filter(row => (!f.branchId || row.branch_id === f.branchId) && (!f.semesterId || row.semester_id === f.semesterId) && (!f.sectionId || row.section_id === f.sectionId) && (!f.subjectId || row.subject_id === f.subjectId));
  const selected = (key, value) => String(f[key] || '') === String(value) ? 'selected' : '';
  const adminFilters = admin ? `<label>Branch<select name="branchId"><option value="">All branches</option>${branches.map(row=>`<option value="${row.id}" ${selected('branchId',row.id)}>${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId"><option value="">All semesters</option>${semesters.map(row=>`<option value="${row.id}" ${selected('semesterId',row.id)}>Semester ${row.number}</option>`).join('')}</select></label><label>Section<select name="sectionId"><option value="">All sections</option>${sections.map(row=>`<option value="${row.id}" ${selected('sectionId',row.id)}>${escapeHtml(row.branch_code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Subject<select name="subjectId"><option value="">All subjects</option>${subjects.map(row=>`<option value="${row.id}" ${selected('subjectId',row.id)}>${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label>` : '';
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">Report scope</span><h2>Filter attendance data</h2></div></div><form class="filter-form" id="report-filter-form">${adminFilters}<label>From<input name="from" type="date" value="${escapeHtml(f.from || '')}" /></label><label>To<input name="to" type="date" value="${escapeHtml(f.to || '')}" /></label><button class="primary compact">Apply filters</button><button class="secondary compact" type="button" data-clear-report-filters>Clear</button></form></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Subject-wise records</span><h2>Download attendance</h2></div><span class="pill">${offerings.length} courses</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Class</th><th>Room</th><th>Exports</th></tr></thead><tbody>${offerings.map(row=>`<tr><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.code || row.subject_code)}</small></td><td>${escapeHtml(row.branch)} · Section ${escapeHtml(row.section)}</td><td>${escapeHtml(row.default_room)}</td><td><div class="report-actions"><button class="table-action" data-download-report="${row.id}" data-format="xlsx">Excel</button><button class="table-action" data-download-report="${row.id}" data-format="pdf">PDF</button><button class="table-action" data-view-report="${row.id}">View</button></div></td></tr>`).join('') || emptyTableRow('No course reports match these filters.', 4)}</tbody></table></div></article>`;
}

async function renderReportDetail(id) {
  const params = new URLSearchParams();
  if (state.reportFilters.from) params.set('from', state.reportFilters.from);
  if (state.reportFilters.to) params.set('to', state.reportFilters.to);
  const data = await api(`/api/reports/offerings/${id}${params.size ? `?${params}` : ''}`);
  openModal(`<span class="eyebrow">Below ${data.threshold}% highlighted</span><h2>${escapeHtml(data.offering.subject_name)}</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Attended</th><th>Conducted</th><th>Percentage</th></tr></thead><tbody>${data.rows.map(row=>`<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.roll_number)}</small></td><td>${row.attended}</td><td>${row.conducted}</td><td class="${row.below_threshold?'warning-text':''}"><strong>${row.percentage}%</strong></td></tr>`).join('')}</tbody></table></div>`);
}

async function renderSecurity() {
  heading('Trust and recovery', 'Security & backups');
  const [audit, backups] = await Promise.all([api('/api/admin/audit'), api('/api/admin/backups')]);
  $('#page-content').innerHTML = `<section class="metrics">${metric('OTP','Login','Passwordless college email',true)}${metric('15 min','Access token','Short-lived authentication')}${metric(audit.length,'Audit events','Latest 500 shown')}${metric(backups.filter(row=>row.status==='succeeded').length,'Backups','Successful recorded runs')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Immutable history</span><h2>Recent audit events</h2></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead><tbody>${audit.slice(0,50).map(row=>`<tr><td>${new Date(row.created_at).toLocaleString()}</td><td>${escapeHtml(row.actor || 'System')}</td><td>${titleCase(row.action)}</td><td>${escapeHtml(row.entity_type)}</td><td><small>${escapeHtml(row.request_id)}</small></td></tr>`).join('') || emptyTableRow('No audit activity has been recorded yet.', 5)}</tbody></table></div></article><article class="panel backup-panel"><div class="panel-header"><div><span class="eyebrow">Recovery</span><h2>Database backups</h2></div><span class="pill">30-day local retention</span></div>${backups.length?backups.map(row=>`<div class="schedule-row backup-row"><span>${new Date(row.started_at).toLocaleDateString()}</span><strong>${titleCase(row.status)}</strong><span>${escapeHtml(row.storage_path||'—')}</span><span>${row.size_bytes||'—'}</span><span></span></div>`).join(''):'<p class="empty">No backup run has been recorded yet. Schedule server/scripts/backup.sh daily.</p>'}</article>`;
}

async function renderTeacherPage(page) {
  if (page === 'reports') return renderReports();
  if (page === 'live' && state.liveSession) return renderLiveSession();
  const classes = await api('/api/teacher/classes');
  const threshold = classes[0]?.attendance_threshold ?? '—';
  heading('Teacher workspace', page === 'classes' ? 'Take attendance' : `${greeting()}, ${state.user.full_name.split(' ')[0]}.`);
  $('#page-content').innerHTML = `
    <section class="metrics">
      ${metric(classes.length, 'Assigned classes', 'Current semester', true)}
      ${metric(`${threshold}%`, 'Required attendance', 'College threshold')}
      ${metric('ESP32', 'Attendance method', 'Rotating classroom beacon')}
      ${metric('Live', 'Roster updates', 'Every two seconds')}
    </section>
    <article class="panel">
      <div class="panel-header"><div><span class="eyebrow">Current semester</span><h2>Your classes</h2></div></div>
      ${classes.map(row => `
        <div class="schedule-row teacher-class-row">
          <span class="day">${escapeHtml(row.code)}</span>
          <strong>${escapeHtml(row.subject)}</strong>
          <span>${escapeHtml(row.branch)} · Section ${escapeHtml(row.section)} · Sem ${escapeHtml(String(row.semester))}</span>
          <span>Room ${escapeHtml(row.default_room)}</span>
          <button class="primary compact" data-start-session="${row.id}" data-room="${escapeHtml(row.default_room)}" data-subject="${escapeHtml(row.subject)}">Take attendance</button>
          <button class="table-action" data-view-report="${row.id}">Report</button>
        </div>`).join('') || '<div class="empty">No classes are assigned to you yet.</div>'}
    </article>`;
}

function openStartSessionDialog(offeringId, subject, defaultRoom) {
  openModal(`
    <span class="eyebrow">New attendance window</span>
    <h2>${escapeHtml(subject)}</h2>
    <form id="start-session-form">
      <label>Classroom<input name="room" value="${escapeHtml(defaultRoom || '')}" required autocomplete="off" /></label>
      <span class="field-label">Duration</span>
      <div class="duration-grid">
        ${[1, 2, 3, 5].map((minutes, index) => `
          <label class="duration-option${index === 2 ? ' selected' : ''}">
            <input type="radio" name="minutes" value="${minutes}" ${index === 2 ? 'checked' : ''} />
            <strong>${minutes}</strong><small>min</small>
          </label>`).join('')}
        <label class="duration-option">
          <input type="radio" name="minutes" value="custom" />
          <strong>Custom</strong><small>30–600 s</small>
        </label>
      </div>
      <label id="custom-duration-field" class="hidden">Seconds<input name="customSeconds" type="number" min="30" max="600" value="180" /></label>
      <button class="primary" type="submit">Open attendance window</button>
      <p class="field-note">The ESP32 in this room starts broadcasting a code that changes every 30 seconds. Students must be inside to capture it.</p>
    </form>`);

  $$('#start-session-form input[name="minutes"]').forEach(input => input.addEventListener('change', () => {
    $$('.duration-option').forEach(option => option.classList.toggle('selected', option.contains(input) && input.checked));
    $('#custom-duration-field').classList.toggle('hidden', input.value !== 'custom' || !input.checked);
  }));

  $('#start-session-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    setButtonBusy(button, true, 'Opening…');
    try {
      const data = new FormData(event.target);
      const choice = data.get('minutes');
      const durationSeconds = choice === 'custom'
        ? Math.max(30, Math.min(600, Number(data.get('customSeconds')) || 180))
        : Number(choice) * 60;
      const session = await api('/api/attendance/sessions', {
        method: 'POST',
        body: { offeringId, room: data.get('room'), durationSeconds }
      });
      closeModal();
      state.liveSession = session;
      if (session.beaconWarning) toast(session.beaconWarning);
      await navigate('live');
    } catch (error) {
      if (error.code === 'SESSION_ALREADY_ACTIVE' || error.code === 'ROOM_ALREADY_ACTIVE') {
        toast(error.message);
        if (error.sessionId) { closeModal(); state.liveSession = { id: error.sessionId }; await navigate('live'); return; }
      }
      toast(error.message || 'The attendance window could not be opened.');
    } finally {
      setButtonBusy(button, false);
    }
  }, { once: true });
}

/* ---------------------------------------------------------------------------
 * Live attendance screen. Polls the authoritative roster every two seconds;
 * the countdown is rendered from the server's secondsRemaining, never from a
 * local clock, so a paused tab or a slow phone cannot extend the window.
 * ------------------------------------------------------------------------ */
function stopLivePolling() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}

async function renderLiveSession() {
  const sessionId = state.liveSession?.id;
  if (!sessionId) return navigate('classes');
  heading('Live attendance', 'Attendance in progress');
  const live = await api(`/api/attendance/sessions/${sessionId}/live`);
  state.liveSession = live;
  $('#page-content').innerHTML = liveSessionMarkup(live);
  stopLivePolling();
  livePollTimer = setInterval(async () => {
    if (state.page !== 'live') return stopLivePolling();
    try {
      const next = await api(`/api/attendance/sessions/${sessionId}/live`);
      state.liveSession = next;
      paintLiveSession(next);
      if (next.status !== 'active') stopLivePolling();
    } catch { /* a dropped poll is not fatal; the next tick retries */ }
  }, 2000);
}

const formatClock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

function liveSessionMarkup(live) {
  const active = live.status === 'active' && live.secondsRemaining > 0;
  return `
    <section class="live-header ${active ? 'live-active' : 'live-ended'}">
      <div>
        <span class="eyebrow light"><i class="eyebrow-dot"></i>${active ? 'Attendance open' : 'Window closed'}</span>
        <h2>${escapeHtml(live.subject)}</h2>
        <p>${escapeHtml(live.branch)} · Section ${escapeHtml(live.section)} · Room ${escapeHtml(live.room)}</p>
      </div>
      <div class="live-timer"><strong id="live-clock">${formatClock(live.secondsRemaining)}</strong><small>remaining</small></div>
      <div class="live-count"><strong><span id="live-present">${live.present}</span> / ${live.total}</strong><small>present</small></div>
    </section>

    <section class="live-progress"><i id="live-bar" style="width:${live.total ? (live.present / live.total) * 100 : 0}%"></i></section>

    <article class="panel">
      <div class="panel-header">
        <div><span class="eyebrow">Classroom beacon</span><h2 id="beacon-state">${live.beacon ? (live.beacon.online ? `${escapeHtml(live.beacon.label)} is broadcasting` : `${escapeHtml(live.beacon.label)} is not responding`) : 'No ESP32 registered for this room'}</h2></div>
        <span class="pill ${live.beacon?.online ? '' : 'warn'}" id="beacon-pill">${live.beacon ? (live.beacon.online ? 'Online' : 'Offline') : 'None'}</span>
      </div>
      ${live.beacon ? '' : '<p class="ble-explainer">Students cannot detect this room until an administrator assigns an ESP32 beacon to it in Rooms &amp; beacons.</p>'}
    </article>

    <article class="panel">
      <div class="panel-header">
        <div><span class="eyebrow">Roster</span><h2>Students</h2></div>
        <div class="live-controls">
          <input id="roster-search" class="inline-search" placeholder="Search name or roll" value="${escapeHtml(state.rosterFilter)}" />
          ${active ? '<button class="table-action danger" data-close-session>Close now</button>' : '<button class="table-action" data-page="classes">Back to classes</button>'}
        </div>
      </div>
      <div id="roster-list" class="roster-list">${rosterMarkup(live.roster)}</div>
    </article>`;
}

function rosterMarkup(roster) {
  const filter = state.rosterFilter.trim().toLowerCase();
  const rows = roster.filter(student =>
    !filter || student.full_name.toLowerCase().includes(filter) || String(student.roll_number).toLowerCase().includes(filter));
  if (!rows.length) return '<div class="empty">No student matches that search.</div>';
  return rows.map(student => `
    <div class="roster-row ${student.status === 'present' ? 'is-present' : ''}">
      <span class="roster-mark">${student.status === 'present' ? icon('check', 15) : ''}</span>
      <div class="roster-identity"><strong>${escapeHtml(student.full_name)}</strong><small>${escapeHtml(student.roll_number)}</small></div>
      <span class="roster-method">${student.status === 'present' ? methodLabel(student.method) : 'Not marked'}</span>
      <button class="table-action" data-manual-mark="${student.id}" data-student-name="${escapeHtml(student.full_name)}" data-current="${student.status}">
        ${student.status === 'present' ? 'Mark absent' : 'Mark present'}
      </button>
    </div>`).join('');
}

const methodLabel = (method) => ({
  barcode_ble: 'Bluetooth + ID card',
  barcode_web_ble: 'Web Bluetooth + ID card',
  manual: 'Manual',
  admin_correction: 'Admin correction'
}[method] || 'Present');

/** Repaint only what changed, so the search box keeps focus while polling. */
function paintLiveSession(live) {
  const clock = $('#live-clock');
  if (clock) clock.textContent = formatClock(live.secondsRemaining);
  const present = $('#live-present');
  if (present && present.textContent !== String(live.present)) {
    present.textContent = live.present;
    present.classList.remove('count-bump');
    void present.offsetWidth;
    present.classList.add('count-bump');
  }
  const bar = $('#live-bar');
  if (bar) bar.style.width = `${live.total ? (live.present / live.total) * 100 : 0}%`;
  const pill = $('#beacon-pill');
  if (pill && live.beacon) {
    pill.textContent = live.beacon.online ? 'Online' : 'Offline';
    pill.classList.toggle('warn', !live.beacon.online);
  }
  const list = $('#roster-list');
  if (list && document.activeElement?.id !== 'roster-list') list.innerHTML = rosterMarkup(live.roster);
  if (live.status !== 'active' || live.secondsRemaining <= 0) {
    const header = $('.live-header');
    if (header && !header.classList.contains('live-ended')) {
      header.classList.replace('live-active', 'live-ended');
      $('.live-header .eyebrow').innerHTML = 'Window closed';
      toast('Attendance window closed. Everyone unmarked is now recorded absent.');
    }
  }
}

function openManualMarkDialog(studentId, studentName, currentStatus) {
  const nextStatus = currentStatus === 'present' ? 'absent' : 'present';
  openModal(`
    <span class="eyebrow">Manual correction</span>
    <h2>${escapeHtml(studentName)}</h2>
    <p class="modal-copy">Marking this student <strong>${nextStatus}</strong>. Every manual change is recorded against your account with the reason you give.</p>
    <form id="manual-mark-form">
      <label>Reason<input name="reason" required minlength="4" placeholder="Phone battery dead, damaged ID card, …" autofocus /></label>
      <button class="primary" type="submit">Record ${nextStatus}</button>
    </form>`);
  $('#manual-mark-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    setButtonBusy(button, true, 'Saving…');
    try {
      await api(`/api/attendance/sessions/${state.liveSession.id}/manual`, {
        method: 'POST',
        body: { studentId, status: nextStatus, reason: new FormData(event.target).get('reason') }
      });
      closeModal();
      toast(`${studentName} marked ${nextStatus}`);
      const live = await api(`/api/attendance/sessions/${state.liveSession.id}/live`);
      state.liveSession = live;
      paintLiveSession(live);
      const list = $('#roster-list');
      if (list) list.innerHTML = rosterMarkup(live.roster);
    } catch (error) {
      toast(error.message || 'The correction could not be saved.');
    } finally {
      setButtonBusy(button, false);
    }
  }, { once: true });
}

/* ------------------------------- Rooms & beacons (admin) ----------------- */
async function renderClassrooms() {
  heading('Hardware', 'Rooms & beacons');
  const [classrooms, beacons] = await Promise.all([api('/api/admin/classrooms'), api('/api/admin/beacons')]);
  const online = beacons.filter(row => row.online).length;
  $('#page-content').innerHTML = `
    <section class="metrics">
      ${metric(classrooms.length, 'Classrooms', 'Registered rooms', true)}
      ${metric(beacons.length, 'Beacons', 'Provisioned ESP32 devices')}
      ${metric(online, 'Online now', 'Reported in the last minute')}
      ${metric(beacons.filter(row => !row.classroom_id).length, 'Unassigned', 'Needs a room')}
    </section>

    <article class="panel">
      <div class="panel-header"><div><span class="eyebrow">Registry</span><h2>Classrooms</h2></div><button class="primary compact" data-add-classroom>Add classroom</button></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Room</th><th>Building</th><th>Beacon</th><th>Signal floor</th><th>Status</th></tr></thead>
        <tbody>${classrooms.map(row => `
          <tr>
            <td><strong>${escapeHtml(row.room_number)}</strong></td>
            <td>${escapeHtml(row.building || '—')}</td>
            <td>${row.beacon_code ? escapeHtml(row.beacon_code) : '<span class="warning-text">None assigned</span>'}</td>
            <td>${row.min_rssi} dBm</td>
            <td><span class="pill ${row.beacon_online ? '' : 'warn'}">${row.beacon_code ? (row.beacon_online ? 'Online' : 'Offline') : 'No beacon'}</span></td>
          </tr>`).join('') || emptyTableRow('No classroom has been registered yet.', 5)}</tbody>
      </table></div>
    </article>

    <article class="panel">
      <div class="panel-header"><div><span class="eyebrow">Hardware</span><h2>ESP32 beacons</h2></div><button class="primary compact" data-add-beacon>Provision beacon</button></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Beacon</th><th>Room</th><th>Firmware</th><th>Last seen</th><th>Sessions</th><th>Action</th></tr></thead>
        <tbody>${beacons.map(row => `
          <tr>
            <td><strong>${escapeHtml(row.beacon_code)}</strong><br /><small>${escapeHtml(row.label)}</small></td>
            <td>${row.room_number ? escapeHtml(row.room_number) : '<span class="warning-text">Unassigned</span>'}</td>
            <td>${escapeHtml(row.firmware_version || '—')}</td>
            <td><span class="pill ${row.online ? '' : 'warn'}">${row.last_seen_at ? new Date(row.last_seen_at).toLocaleTimeString() : 'Never'}</span></td>
            <td>${row.sessions_served}</td>
            <td><button class="table-action" data-rotate-beacon="${row.id}" data-beacon-code="${escapeHtml(row.beacon_code)}">Rotate key</button></td>
          </tr>`).join('') || emptyTableRow('No beacon has been provisioned yet.', 6)}</tbody>
      </table></div>
    </article>`;
}

function showBeaconKey(beaconCode, deviceKey) {
  openModal(`
    <span class="eyebrow">Shown once</span>
    <h2>${escapeHtml(beaconCode)} device key</h2>
    <p class="modal-copy">Paste this into <code>attendesk_beacon.ino</code> as <code>BEACON_KEY</code> and flash the ESP32. AttenDesk stores only its hash, so this value cannot be shown again — rotate the key if you lose it.</p>
    <pre class="key-block">${escapeHtml(deviceKey)}</pre>`);
}

function webBluetoothCardMarkup() {
  if (!webBluetoothSupported()) {
    return `<article id="web-bluetooth-card" class="panel ble-discovery-panel"><div class="panel-header"><div><span class="eyebrow">Bluetooth attendance</span><h2>This browser cannot scan the classroom beacon</h2></div><span class="pill warn">Unsupported</span></div><p class="ble-explainer">Open this HTTPS website in Chrome on an Android phone. Safari on iPhone and Firefox do not provide the Web Bluetooth connection required by Attendesk.</p></article>`;
  }
  const nearby = state.webBleNearby;
  if (nearby) {
    return `<article id="web-bluetooth-card" class="panel ble-discovery-panel ble-found"><div class="panel-header"><div><span class="eyebrow"><i class="eyebrow-dot"></i>Classroom beacon connected</span><h2>Available attendance</h2></div><span class="pill">Bluetooth verified</span></div><div class="ble-bubble-wrap"><button class="ble-class-bubble" data-web-ble-scan><span>ROOM ${escapeHtml(nearby.session.room)}</span><strong>${escapeHtml(nearby.session.subject)}</strong><small>${escapeHtml(nearby.session.teacher)} · ${escapeHtml(nearby.session.branch)} ${escapeHtml(nearby.session.section)}</small><b>Scan ID card</b></button><div class="ble-orbit orbit-a"></div><div class="ble-orbit orbit-b"></div></div><p class="ble-explainer">Connected through ${escapeHtml(nearby.deviceName || 'the teacher beacon')}. Keep Bluetooth on and scan the printed barcode on your own college ID.</p><button class="text-button left" data-web-ble-connect>Choose a different beacon</button></article>`;
  }
  return `<article id="web-bluetooth-card" class="panel ble-discovery-panel"><div class="panel-header"><div><span class="eyebrow">Bluetooth attendance</span><h2>Find your teacher's class</h2></div><span class="pill">Chrome · Android</span></div><div class="ble-ready"><span class="ble-symbol">${icon('bluetooth',28)}</span><div><strong>Bluetooth is requested only after you tap.</strong><p>The browser will show nearby Attendesk classroom beacons. Select your classroom's ESP32.</p></div><button class="primary ble-connect-button" data-web-ble-connect>Find nearby class</button></div><p class="ble-explainer">Requires HTTPS, Bluetooth enabled, Chrome on Android, and an online classroom ESP32 broadcasting an active attendance session.</p></article>`;
}

function tokenFromDataView(value) {
  return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function connectGattWithRetry(device, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await device.gatt.connect();
    } catch (error) {
      lastError = error;
      if (device.gatt.connected) device.gatt.disconnect();
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError || new Error('Could not connect to the teacher beacon.');
}

async function discoverWebBluetoothClass() {
  if (!webBluetoothSupported()) throw new Error('Use Chrome on Android over HTTPS for Web Bluetooth attendance.');
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [ATTENDESK_BLE_SERVICE] }] });
  let server;
  try {
    server = await connectGattWithRetry(device);
    const service = await server.getPrimaryService(ATTENDESK_BLE_SERVICE);
    const characteristic = await service.getCharacteristic(ATTENDESK_TOKEN_CHARACTERISTIC);
    const value = await characteristic.readValue();
    const token = tokenFromDataView(value);
    if (!/^[a-f0-9]{16}$/.test(token)) throw new Error('The selected Bluetooth device is not a valid Attendesk beacon.');
    const session = await api(`/api/attendance/beacons/${token}`);
    state.webBleNearby = { session, token, device, deviceName: device.name || 'Attendesk classroom beacon' };
    const card = $('#web-bluetooth-card');
    if (card) card.outerHTML = webBluetoothCardMarkup();
    toast(`${session.subject} is ready`);
  } finally {
    if (server?.connected) device.gatt.disconnect();
  }
}

async function scanBarcodeWithCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable. Open Attendesk over HTTPS.');
  if (!('BarcodeDetector' in window)) throw new Error('Live barcode scanning requires current Chrome on Android.');
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = ['code_128', 'code_39', 'codabar', 'ean_13', 'ean_8', 'itf'].filter(format => supported.includes(format));
  if (!formats.length) throw new Error('This browser cannot read the barcode format used by Attendesk.');
  const detector = new BarcodeDetector({ formats });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  openModal(`<span class="eyebrow">ID verification</span><h2>Scan your college ID card</h2><div class="barcode-camera"><video id="barcode-video" playsinline muted></video><div class="scan-frame"><i></i></div></div><p id="barcode-status" class="ble-explainer">Place the printed barcode inside the frame. Attendance is submitted only after Bluetooth and barcode verification.</p>`);
  const video = $('#barcode-video');
  video.srcObject = stream;
  await video.play();
  return new Promise((resolve, reject) => {
    let stopped = false;
    let frame;
    const timeout = setTimeout(() => finish(new Error('No barcode detected. Improve the light and try again.')), 45_000);
    const cleanup = () => {
      stopped = true;
      clearTimeout(timeout);
      if (frame) cancelAnimationFrame(frame);
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
      cancelActiveBarcodeScan = null;
    };
    const finish = (error, value) => {
      if (stopped) return;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    cancelActiveBarcodeScan = () => finish(new Error('Barcode scan cancelled.'));
    const detect = async () => {
      if (stopped) return;
      try {
        const results = await detector.detect(video);
        const rawValue = results.find(result => String(result.rawValue || '').trim())?.rawValue;
        if (rawValue) return finish(null, String(rawValue).trim());
      } catch (error) {
        return finish(new Error('The camera scanner stopped unexpectedly.'));
      }
      frame = requestAnimationFrame(detect);
    };
    frame = requestAnimationFrame(detect);
  });
}

async function markAttendanceFromWebsite() {
  const nearby = state.webBleNearby;
  if (!nearby) throw new Error('Connect to the classroom Bluetooth beacon first.');
  const barcode = await scanBarcodeWithCamera();
  closeModal();
  // The camera may take longer than a beacon-code rotation. Read again before submission.
  try {
    const server = await connectGattWithRetry(nearby.device);
    const service = await server.getPrimaryService(ATTENDESK_BLE_SERVICE);
    const characteristic = await service.getCharacteristic(ATTENDESK_TOKEN_CHARACTERISTIC);
    nearby.token = tokenFromDataView(await characteristic.readValue());
  } finally {
    if (nearby.device?.gatt.connected) nearby.device.gatt.disconnect();
  }
  await api(`/api/attendance/sessions/${nearby.session.id}/mark`, {
    method: 'POST',
    body: { installationId: installationId(), barcode, beaconToken: nearby.token }
  });
  state.webBleNearby = null;
  toast('Attendance marked successfully');
  await navigate('overview');
}

async function renderStudentPage() {
  heading('Student dashboard', `${greeting()}, ${state.user.full_name.split(' ')[0]}.`);
  const [data, history, appeals] = await Promise.all([api('/api/student/dashboard'), api('/api/student/history'), api('/api/student/appeals')]);
  const overallStatus = data.conducted === 0 ? 'No classes yet' : data.overallPercentage >= data.threshold ? 'On track' : 'Action needed';
  const overallWarning = data.conducted > 0 && data.overallPercentage < data.threshold;
  $('#page-content').innerHTML = `<section class="metrics">${metric(`${data.overallPercentage}%`,'Overall attendance',`${data.attended} of ${data.conducted} classes`,true)}${metric(data.subjects.length,'Subjects','Current enrollments')}${metric(data.subjects.filter(row=>row.belowThreshold).length,'Below threshold',`Required ${data.threshold}%`)}${metric('Android','Marking access','ESP32 classroom beacon')}</section>${webBluetoothCardMarkup()}<article class="panel"><div class="panel-header"><div><span class="eyebrow">Subject-wise attendance</span><h2>Your complete record</h2></div><span class="pill ${overallWarning?'warn':''}">${overallStatus}</span></div>${data.subjects.map(row=>`<div class="schedule-row attendance-row"><span class="person-avatar">${escapeHtml(row.subject_code.slice(0,2))}</span><div><strong>${escapeHtml(row.subject)}</strong><div class="subject-progress"><i style="width:${Math.min(100,row.percentage)}%"></i></div></div><span>${row.attended} / ${row.conducted}</span><strong class="${row.belowThreshold?'warning-text':''}">${row.percentage}%</strong><span>${row.conducted===0?'Not started':row.belowThreshold?`Below ${data.threshold}%`:'On track'}</span></div>`).join('') || '<div class="empty">No subjects have been assigned yet.</div>'}</article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Attendance history</span><h2>Recent classes</h2></div><span class="pill">${history.length} records</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Subject</th><th>Teacher</th><th>Status</th><th>Appeal</th></tr></thead><tbody>${history.map(row=>`<tr><td>${escapeHtml(new Date(row.starts_at).toLocaleString())}</td><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.subject_code)} · Room ${escapeHtml(row.room)}</small></td><td>${escapeHtml(row.teacher)}</td><td><span class="pill ${row.status==='absent'?'warn':''}">${titleCase(row.status)}</span>${row.correction_reason?`<br/><small>${escapeHtml(row.correction_reason)}</small>`:''}</td><td>${row.appeal_status?`<span class="pill ${row.appeal_status==='pending'?'warn':''}">${titleCase(row.appeal_status)}</span>`:row.attendance_record_id?`<button class="table-action" data-student-appeal="${row.attendance_record_id}" data-subject="${escapeHtml(row.subject)}">Request correction</button>`:'—'}</td></tr>`).join('') || emptyTableRow('No completed classes yet.', 5)}</tbody></table></div></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Correction history</span><h2>Your appeals</h2></div><span class="pill">${appeals.length}</span></div>${appeals.map(row=>`<div class="appeal-row"><div><strong>${escapeHtml(row.subject)}</strong><small>${new Date(row.starts_at).toLocaleString()} · ${titleCase(row.current_status)}</small><p>${escapeHtml(row.reason)}</p>${row.resolution_note?`<p><strong>Resolution:</strong> ${escapeHtml(row.resolution_note)}</p>`:''}</div><span class="pill ${row.status==='pending'?'warn':''}">${titleCase(row.status)}</span></div>`).join('') || '<div class="empty">You have not submitted any attendance appeals.</div>'}</article>`;
}

function openModal(html) { $('#modal-content').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() {
  if (cancelActiveBarcodeScan) {
    const cancel = cancelActiveBarcodeScan;
    cancelActiveBarcodeScan = null;
    cancel();
  }
  $('#modal').classList.add('hidden');
}

async function openAddPersonDialog(role) {
  const [branches, semesters, sections] = await Promise.all([
    api('/api/admin/academic/branches'),
    api('/api/admin/academic/semesters'),
    api('/api/admin/sections')
  ]);
  const activeBranches = branches.filter(row => row.active);
  const activeSemesters = semesters.filter(row => row.active);
  const activeSections = sections.filter(row => row.active);
  if (role === 'student' && (!activeBranches.length || !activeSemesters.length || !activeSections.length)) {
    openModal(`<span class="eyebrow">Prerequisites needed</span><h2>Create the academic structure first</h2><p class="modal-copy">A student must belong to an active branch, semester and section.</p><button class="primary" data-page="academic">Open academic setup</button>`);
    return;
  }
  const domain = String(state.user.email || '').split('@')[1] || 'hbtu.ac.in';
  const roleFields = role === 'teacher'
    ? `<div class="field-grid"><label>Employee code<input name="employeeCode" required autocomplete="off" placeholder="FT-EMP-01" /></label><label>Branch<select name="branchId"><option value="">College-wide / optional</option>${activeBranches.map(row => `<option value="${row.id}">${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label></div><label>Initial password<input name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters with letters and numbers" /></label>`
    : `<div class="field-grid"><label>Roll number<input name="rollNumber" required autocomplete="off" /></label><label>Class section<select name="sectionId" id="person-section" required>${activeSections.map(row => `<option value="${row.id}" data-branch-id="${row.branch_id}" data-semester-id="${row.semester_id}">${escapeHtml(row.branch_code)} · Semester ${row.semester_number} · Section ${escapeHtml(row.name)}</option>`).join('')}</select></label></div><div class="field-grid"><label>ID-card barcode<input name="barcode" minlength="4" autocomplete="off" placeholder="Optional now" /></label><label>Initial password<input name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters with letters and numbers" /></label></div>`;
  openModal(`<span class="eyebrow">Direct account creation</span><h2>Add ${escapeHtml(role)}</h2><form id="person-form"><input type="hidden" name="role" value="${role}" /><div class="field-grid"><label>Full name<input name="fullName" required autocomplete="name" /></label><label>College email<input name="email" type="email" required placeholder="name@${escapeHtml(domain)}" autocomplete="email" /></label></div><label>Phone number<input name="phone" inputmode="tel" autocomplete="tel" placeholder="Optional" /></label>${roleFields}<button class="primary" type="submit">Create ${escapeHtml(role)}</button><p class="field-note">${role === 'teacher' ? 'The employee code becomes the teacher username.' : 'The student uses this full name, roll number and password in the Android app.'}</p></form>`);
  $('#person-form').addEventListener('submit', async formEvent => {
    formEvent.preventDefault();
    const button = formEvent.submitter;
    setButtonBusy(button, true, 'Creating…');
    try {
      const body = Object.fromEntries(new FormData(formEvent.target).entries());
      if (role === 'student') {
        const section = $('#person-section').selectedOptions[0];
        body.branchId = section.dataset.branchId;
        body.semesterId = section.dataset.semesterId;
      }
      const result = await api('/api/admin/people', { method: 'POST', body });
      closeModal();
      toast(`${titleCase(role)} created · login ${result.loginIdentifier}`);
      state.peopleRole = role;
      await navigate('people');
    } catch (error) {
      toast(error.message || `Could not create ${role}`);
    } finally {
      setButtonBusy(button, false);
    }
  }, { once: true });
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value.trim()); value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value.trim()); value = '';
      if (row.some(cell => cell)) rows.push(row);
      row = [];
    } else value += character;
  }
  row.push(value.trim());
  if (row.some(cell => cell)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map(header => header.trim().toLowerCase().replace(/^\uFEFF/, ''));
  return rows.map(columns => Object.fromEntries(headers.map((header, index) => [header, columns[index] || ''])));
}

const importDefinitions = {
  students: {
    title: 'Students', description: 'Accounts, class assignment and optional ID-card barcode',
    headers: 'full_name,college_email,roll_number,branch_code,semester,section_name,phone,barcode,password',
    sample: 'Example Student,student@hbtu.ac.in,250107001,FT,1,A,9876543210,1234567890,StudentPass99'
  },
  teachers: {
    title: 'Teachers', description: 'Faculty accounts, employee codes and initial passwords',
    headers: 'full_name,college_email,employee_code,branch_code,phone,password',
    sample: 'Example Teacher,teacher@hbtu.ac.in,FT-EMP-01,FT,9876543210,TeacherPass99'
  },
  subjects: {
    title: 'Subjects', description: 'Subject codes, names and credits; existing codes are updated',
    headers: 'subject_code,subject_name,credits', sample: 'FT-201,Fluid Mechanics,4'
  },
  courses: {
    title: 'Courses', description: 'Map each subject to its teacher and class section',
    headers: 'subject_code,teacher_employee_code,branch_code,semester,section_name,default_room',
    sample: 'FT-201,FT-EMP-01,FT,1,A,210'
  },
  enrollments: {
    title: 'Enrollments', description: 'Add student roll numbers to course rosters',
    headers: 'subject_code,teacher_employee_code,branch_code,semester,section_name,student_roll_number',
    sample: 'FT-201,FT-EMP-01,FT,1,A,250107001'
  },
  timetables: {
    title: 'Timetable', description: 'Weekly periods with automatic teacher, section and room conflict checks',
    headers: 'subject_code,teacher_employee_code,branch_code,semester,section_name,day_of_week,starts_at,ends_at,room,valid_from,valid_until',
    sample: 'FT-201,FT-EMP-01,FT,1,A,Monday,10:00,11:00,210,2026-07-01,2026-12-31'
  }
};

function downloadImportTemplate(entity) {
  const definition = importDefinitions[entity];
  if (!definition) return;
  const content = `${definition.headers}\n${definition.sample}\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `attendesk-${entity}-import-template.csv`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openImportDialog(entity) {
  const definition = importDefinitions[entity];
  if (!definition) return toast('This import type is not available');
  openModal(`<span class="eyebrow">Bulk onboarding</span><h2>Import ${escapeHtml(definition.title)}</h2><p class="modal-copy">${escapeHtml(definition.description)}. Download the template so the column names stay exact.</p><button class="secondary compact" type="button" data-download-import-template="${entity}">Download CSV template</button><form id="bulk-import-form"><label>CSV file<input name="file" type="file" accept=".csv,text/csv" required /></label><div id="import-preview" class="import-preview">Choose a file to preview its row count.</div><button class="primary" type="submit">Import ${escapeHtml(definition.title)}</button><p class="field-note">Columns: ${escapeHtml(definition.headers)}. Maximum 1,000 rows.</p></form>`);
  const fileInput = $('#bulk-import-form input[type="file"]');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    const rows = file ? parseCsv(await file.text()) : [];
    $('#import-preview').textContent = rows.length ? `${rows.length} data rows ready to import` : 'No data rows found in this file.';
  });
  $('#bulk-import-form').addEventListener('submit', async formEvent => {
    formEvent.preventDefault();
    const button = formEvent.submitter;
    const file = new FormData(formEvent.target).get('file');
    if (!(file instanceof File) || !file.size) return toast('Choose a CSV file first');
    setButtonBusy(button, true, 'Importing…');
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error('The CSV does not contain any data rows');
      const result = await api(`/api/admin/import/${entity}`, { method: 'POST', body: { rows } });
      openModal(`<span class="eyebrow">Import complete</span><h2>${result.created} created${result.updated ? ` · ${result.updated} updated` : ''}</h2><div class="import-summary"><span>${result.skipped || 0} skipped</span><span>${result.errors.length} errors</span></div>${result.errors.length ? `<div class="import-errors">${result.errors.slice(0, 50).map(item => `<p><strong>Row ${item.row}</strong> ${escapeHtml(item.message)}</p>`).join('')}</div><button class="secondary compact" data-download-import-errors>Copy error list</button>` : '<p class="modal-copy">Every row was imported successfully.</p>'}<button class="primary" data-page="bulk-import">Back to imports</button>`);
      if (result.errors.length) $('#modal-content').dataset.importErrors = JSON.stringify(result.errors);
    } catch (error) {
      toast(error.message || 'CSV import failed');
    } finally {
      setButtonBusy(button, false);
    }
  }, { once: true });
}

function openResetPasswordDialog(userId, userName) {
  openModal(`<span class="eyebrow">Credential recovery</span><h2>Reset ${escapeHtml(userName)}'s password</h2><form id="admin-reset-password-form"><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password" /></label><button class="primary" type="submit">Reset password</button><p class="field-note">This signs the user out from every existing session.</p></form>`);
  $('#admin-reset-password-form').addEventListener('submit', async formEvent => {
    formEvent.preventDefault();
    const button = formEvent.submitter;
    setButtonBusy(button, true, 'Resetting…');
    try {
      const password = new FormData(formEvent.target).get('password');
      const result = await api(`/api/admin/users/${userId}/reset-password`, { method: 'POST', body: { password } });
      closeModal(); toast(result.message);
    } catch (error) { toast(error.message || 'Password reset failed'); }
    finally { setButtonBusy(button, false); }
  }, { once: true });
}

async function openRosterDialog(offeringId, courseName) {
  const rows = await api(`/api/admin/enrollments?offeringId=${encodeURIComponent(offeringId)}`);
  openModal(`<span class="eyebrow">Course roster</span><h2>${escapeHtml(courseName)}</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Roll number</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.email)}</small></td><td>${escapeHtml(row.roll_number)}</td><td><button class="table-action danger" data-remove-enrollment="${row.id}" data-offering-id="${offeringId}" data-course-name="${escapeHtml(courseName)}">Remove</button></td></tr>`).join('') || emptyTableRow('No students are enrolled yet.', 3)}</tbody></table></div>`);
}

async function openAcademicEditDialog(entity, id) {
  const [rows, branches, semesters] = await Promise.all([
    entity === 'sections' ? api('/api/admin/sections') : api(`/api/admin/academic/${entity}`),
    api('/api/admin/academic/branches'), api('/api/admin/academic/semesters')
  ]);
  const row = rows.find(item => item.id === id);
  if (!row) throw new Error('Academic record not found');
  let fields = '';
  if (entity === 'branches') fields = `<label>Branch code<input name="code" required value="${escapeHtml(row.code)}" /></label><label>Branch name<input name="name" required value="${escapeHtml(row.name)}" /></label>`;
  if (entity === 'subjects') fields = `<label>Subject code<input name="code" required value="${escapeHtml(row.code)}" /></label><label>Subject name<input name="name" required value="${escapeHtml(row.name)}" /></label><label>Credits<input name="credits" type="number" min="0" step="0.5" value="${escapeHtml(row.credits)}" /></label>`;
  if (entity === 'semesters') fields = `<div class="field-grid"><label>Semester<input name="number" type="number" min="1" max="12" required value="${row.number}" /></label><label>Academic year<input name="academic_year" required value="${escapeHtml(row.academic_year)}" /></label></div><label>Term<select name="term">${['odd','even','summer'].map(term=>`<option ${row.term===term?'selected':''}>${term}</option>`).join('')}</select></label><div class="field-grid"><label>Starts on<input name="starts_on" type="date" required value="${String(row.starts_on).slice(0,10)}" /></label><label>Ends on<input name="ends_on" type="date" required value="${String(row.ends_on).slice(0,10)}" /></label></div>`;
  if (entity === 'sections') fields = `<label>Section name<input name="name" required value="${escapeHtml(row.name)}" /></label><div class="field-grid"><label>Branch<select name="branchId">${branches.map(item=>`<option value="${item.id}" ${item.id===row.branch_id?'selected':''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId">${semesters.map(item=>`<option value="${item.id}" ${item.id===row.semester_id?'selected':''}>Semester ${item.number} · ${escapeHtml(item.academic_year)}</option>`).join('')}</select></label></div>`;
  openModal(`<span class="eyebrow">Academic setup</span><h2>Edit ${escapeHtml(entity.slice(0,-1))}</h2><form id="academic-edit-form">${fields}<button class="primary">Save changes</button></form>`);
  $('#academic-edit-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; setButtonBusy(button, true, 'Saving…');
    try {
      const body = Object.fromEntries(new FormData(event.target).entries());
      if (body.number) body.number = Number(body.number); if (body.credits) body.credits = Number(body.credits);
      const path = entity === 'sections' ? `/api/admin/sections/${id}` : `/api/admin/academic/${entity}/${id}`;
      await api(path, { method: 'PATCH', body }); closeModal(); toast('Changes saved'); await navigate('academic');
    } catch (error) { toast(error.message); } finally { setButtonBusy(button, false); }
  }, { once: true });
}

async function openOfferingEditDialog(id) {
  const [offerings, subjects, teachers, sections, semesters] = await Promise.all([
    api('/api/admin/offerings'), api('/api/admin/academic/subjects'), api('/api/admin/people?role=teacher'), api('/api/admin/sections'), api('/api/admin/academic/semesters')
  ]);
  const row = offerings.find(item => item.id === id);
  if (!row) throw new Error('Course not found');
  openModal(`<span class="eyebrow">Course allocation</span><h2>Edit course</h2><form id="offering-edit-form"><label>Subject<select name="subjectId">${subjects.map(item=>`<option value="${item.id}" ${item.id===row.subject_id?'selected':''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Teacher<select name="teacherId">${teachers.map(item=>`<option value="${item.id}" ${item.id===row.teacher_id?'selected':''}>${escapeHtml(item.full_name)}</option>`).join('')}</select></label><label>Section<select name="sectionId">${sections.map(item=>`<option value="${item.id}" ${item.id===row.section_id?'selected':''}>${escapeHtml(item.branch_code)} · Sem ${item.semester_number} · ${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId">${semesters.map(item=>`<option value="${item.id}" ${item.id===row.semester_id?'selected':''}>Semester ${item.number} · ${escapeHtml(item.academic_year)}</option>`).join('')}</select></label><label>Default room<input name="defaultRoom" required value="${escapeHtml(row.default_room)}" /></label><label class="check-label"><input name="active" type="checkbox" ${row.active?'checked':''} /> Active course</label><button class="primary">Save course</button></form>`);
  $('#offering-edit-form').addEventListener('submit', async event => {
    event.preventDefault(); const button=event.submitter; setButtonBusy(button,true,'Saving…');
    try { const body=Object.fromEntries(new FormData(event.target).entries()); body.active=event.target.elements.active.checked; await api(`/api/admin/offerings/${id}`,{method:'PATCH',body}); closeModal(); toast('Course updated'); await navigate('courses'); }
    catch(error){toast(error.message);} finally{setButtonBusy(button,false);}
  }, { once:true });
}

async function openTimetableEditDialog(id) {
  const entries = await api('/api/admin/timetable');
  const row = entries.find(item => item.id === id);
  if (!row) throw new Error('Timetable entry not found');
  openModal(`<span class="eyebrow">Timetable</span><h2>Edit class period</h2><form id="period-edit-form"><label>Day<select name="dayOfWeek">${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day,index)=>`<option value="${index+1}" ${row.day_of_week===index+1?'selected':''}>${day}</option>`).join('')}</select></label><label>Room<input name="room" required value="${escapeHtml(row.room)}" /></label><div class="field-grid"><label>Starts<input name="startsAt" type="time" required value="${String(row.starts_at).slice(0,5)}" /></label><label>Ends<input name="endsAt" type="time" required value="${String(row.ends_at).slice(0,5)}" /></label></div><div class="field-grid"><label>Valid from<input name="validFrom" type="date" required value="${String(row.valid_from).slice(0,10)}" /></label><label>Valid until<input name="validUntil" type="date" required value="${String(row.valid_until).slice(0,10)}" /></label></div><button class="primary">Save period</button></form>`);
  $('#period-edit-form').addEventListener('submit', async event=>{event.preventDefault();const button=event.submitter;setButtonBusy(button,true,'Saving…');try{const body=Object.fromEntries(new FormData(event.target).entries());body.dayOfWeek=Number(body.dayOfWeek);await api(`/api/admin/timetable/${id}`,{method:'PATCH',body});closeModal();toast('Timetable updated');await navigate('timetable');}catch(error){toast(error.message);}finally{setButtonBusy(button,false);}}, {once:true});
}

async function openCorrectionSession(sessionId) {
  const data = await api(`/api/admin/attendance/sessions/${sessionId}/records`);
  openModal(`<span class="eyebrow">${escapeHtml(data.session.subject_code)} · ${new Date(data.session.starts_at).toLocaleString()}</span><h2>Correct attendance roster</h2><p class="modal-copy">Every change requires a reason and is permanently recorded in the audit history.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Current</th><th>Appeal</th><th>History</th><th>Action</th></tr></thead><tbody>${data.records.map(row=>`<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.roll_number)}</small></td><td><span class="pill ${row.status==='absent'?'warn':''}">${titleCase(row.status)}</span></td><td>${row.appeal_status?`<span class="pill ${row.appeal_status==='pending'?'warn':''}">${titleCase(row.appeal_status)}</span>`:'—'}</td><td>${row.correction_count || 0} changes</td><td><button class="table-action" data-correct-student="${row.student_id}" data-correction-session="${sessionId}" data-student-name="${escapeHtml(row.full_name)}" data-current-status="${row.status}">Correct</button></td></tr>`).join('')}</tbody></table></div>${data.history.length?`<details class="history-details"><summary>View ${data.history.length} correction events</summary>${data.history.map(item=>`<p><strong>${new Date(item.created_at).toLocaleString()}</strong> · ${escapeHtml(item.actor || 'System')} · ${titleCase(item.action)}</p>`).join('')}</details>`:''}`);
}

function openCorrectionDialog(sessionId, studentId, studentName, currentStatus) {
  openModal(`<span class="eyebrow">Post-session correction</span><h2>${escapeHtml(studentName)}</h2><form id="attendance-correction-form"><label>Attendance status<select name="status">${['present','absent','excused'].map(status=>`<option value="${status}" ${status===currentStatus?'selected':''}>${titleCase(status)}</option>`).join('')}</select></label><label>Reason<textarea name="reason" required minlength="4" rows="4" placeholder="Explain why this record is being changed"></textarea></label><button class="primary">Save audited correction</button></form>`);
  $('#attendance-correction-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;setButtonBusy(button,true,'Saving…');try{await api(`/api/admin/attendance/sessions/${sessionId}/students/${studentId}`,{method:'PATCH',body:Object.fromEntries(new FormData(event.target).entries())});toast('Attendance corrected and logged');await openCorrectionSession(sessionId);}catch(error){toast(error.message);}finally{setButtonBusy(button,false);}}, {once:true});
}

function openAppealReviewDialog(id, studentName, requestedStatus) {
  openModal(`<span class="eyebrow">Attendance appeal</span><h2>Review ${escapeHtml(studentName)}</h2><form id="appeal-review-form"><label>Decision<select name="decision"><option value="approved">Approve correction</option><option value="rejected">Reject appeal</option></select></label><label>Status if approved<select name="status">${['present','absent','excused'].map(status=>`<option value="${status}" ${status===requestedStatus?'selected':''}>${titleCase(status)}</option>`).join('')}</select></label><label>Resolution note<textarea name="resolutionNote" required minlength="4" rows="4" placeholder="Explain the decision for the student and audit trail"></textarea></label><button class="primary">Submit decision</button></form>`);
  $('#appeal-review-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;setButtonBusy(button,true,'Saving…');try{await api(`/api/admin/attendance/appeals/${id}`,{method:'PATCH',body:Object.fromEntries(new FormData(event.target).entries())});closeModal();toast('Appeal resolved');await navigate('corrections');}catch(error){toast(error.message);}finally{setButtonBusy(button,false);}}, {once:true});
}

function openStudentAppealDialog(recordId, subject) {
  openModal(`<span class="eyebrow">Attendance appeal</span><h2>${escapeHtml(subject)}</h2><form id="student-appeal-form"><label>Requested status<select name="requestedStatus"><option value="present">Present</option><option value="excused">Excused</option><option value="absent">Absent</option></select></label><label>What should be corrected?<textarea name="reason" required minlength="4" rows="4" placeholder="Describe what happened and any evidence the teacher can verify"></textarea></label><button class="primary">Submit appeal</button></form>`);
  $('#student-appeal-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;setButtonBusy(button,true,'Submitting…');try{await api(`/api/student/attendance/${recordId}/appeals`,{method:'POST',body:Object.fromEntries(new FormData(event.target).entries())});closeModal();toast('Appeal submitted');await navigate('overview');}catch(error){toast(error.message);}finally{setButtonBusy(button,false);}}, {once:true});
}

document.addEventListener('click', async event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    if (pageButton.dataset.setupPeople) state.peopleRole = pageButton.dataset.setupPeople;
    closeModal();
    return navigate(pageButton.dataset.page);
  }
  const retryButton = event.target.closest('[data-retry-page]');
  if (retryButton) return navigate(retryButton.dataset.retryPage);
  if (event.target.closest('[data-action="logout"]')) {
    if (state.refresh) await api('/api/auth/logout', { method: 'POST', body: { refreshToken: state.refresh } }).catch(() => null);
    sessionStorage.clear(); state.token = ''; state.refresh = ''; state.user = null; location.reload(); return;
  }
  if (event.target.closest('[data-action="close-modal"]')) return closeModal();
  const downloadTemplate = event.target.closest('[data-download-import-template]');
  if (downloadTemplate) return downloadImportTemplate(downloadTemplate.dataset.downloadImportTemplate);
  const openImport = event.target.closest('[data-open-import]');
  if (openImport) return openImportDialog(openImport.dataset.openImport);
  if (event.target.closest('[data-download-import-errors]')) {
    const errors = JSON.parse($('#modal-content').dataset.importErrors || '[]');
    await navigator.clipboard.writeText(errors.map(item => `Row ${item.row}: ${item.message}`).join('\n'));
    return toast('Error list copied');
  }
  if (event.target.closest('[data-clear-report-filters]')) { state.reportFilters = {}; return navigate('reports'); }
  if (event.target.closest('[data-clear-correction-filters]')) { state.correctionFilters = {}; return navigate('corrections'); }
  const editAcademic = event.target.closest('[data-edit-academic]');
  if (editAcademic) return openAcademicEditDialog(editAcademic.dataset.entity, editAcademic.dataset.editAcademic).catch(error => toast(error.message));
  const editOffering = event.target.closest('[data-edit-offering]');
  if (editOffering) return openOfferingEditDialog(editOffering.dataset.editOffering).catch(error => toast(error.message));
  const editPeriod = event.target.closest('[data-edit-period]');
  if (editPeriod) return openTimetableEditDialog(editPeriod.dataset.editPeriod).catch(error => toast(error.message));
  const correction = event.target.closest('[data-open-correction]');
  if (correction) return openCorrectionSession(correction.dataset.openCorrection).catch(error => toast(error.message));
  const correctStudent = event.target.closest('[data-correct-student]');
  if (correctStudent) return openCorrectionDialog(correctStudent.dataset.correctionSession, correctStudent.dataset.correctStudent, correctStudent.dataset.studentName, correctStudent.dataset.currentStatus);
  const reviewAppeal = event.target.closest('[data-review-appeal]');
  if (reviewAppeal) return openAppealReviewDialog(reviewAppeal.dataset.reviewAppeal, reviewAppeal.dataset.appealStudent, reviewAppeal.dataset.requestedStatus);
  const studentAppeal = event.target.closest('[data-student-appeal]');
  if (studentAppeal) return openStudentAppealDialog(studentAppeal.dataset.studentAppeal, studentAppeal.dataset.subject);
  const addPerson = event.target.closest('[data-add-person]');
  if (addPerson) {
    setButtonBusy(addPerson, true, 'Loading…');
    try { await openAddPersonDialog(addPerson.dataset.addPerson); }
    catch (error) { toast(error.message || 'Could not open account creation'); }
    finally { setButtonBusy(addPerson, false); }
    return;
  }
  const resetPassword = event.target.closest('[data-reset-user-password]');
  if (resetPassword) return openResetPasswordDialog(resetPassword.dataset.resetUserPassword, resetPassword.dataset.userName);
  const viewRoster = event.target.closest('[data-view-roster]');
  if (viewRoster) {
    setButtonBusy(viewRoster, true, 'Loading…');
    try { await openRosterDialog(viewRoster.dataset.viewRoster, viewRoster.dataset.courseName); }
    catch (error) { toast(error.message || 'Could not load the roster'); }
    finally { setButtonBusy(viewRoster, false); }
    return;
  }
  const removeEnrollment = event.target.closest('[data-remove-enrollment]');
  if (removeEnrollment) {
    if (!confirm('Remove this student from the course roster? Existing attendance records are preserved.')) return;
    setButtonBusy(removeEnrollment, true, 'Removing…');
    try {
      await api(`/api/admin/enrollments/${removeEnrollment.dataset.offeringId}/${removeEnrollment.dataset.removeEnrollment}`, { method: 'DELETE' });
      toast('Student removed from roster');
      await openRosterDialog(removeEnrollment.dataset.offeringId, removeEnrollment.dataset.courseName);
    } catch (error) { toast(error.message || 'Could not remove the student'); }
    finally { setButtonBusy(removeEnrollment, false); }
    return;
  }
  const webBleConnect = event.target.closest('[data-web-ble-connect]');
  if (webBleConnect) {
    setButtonBusy(webBleConnect, true, 'Opening Bluetooth…');
    try {
      await discoverWebBluetoothClass();
    } catch (error) {
      if (error.name !== 'NotFoundError') toast(error.message || 'Could not connect to the classroom beacon.');
    } finally {
      setButtonBusy(webBleConnect, false);
    }
    return;
  }
  const webBleScan = event.target.closest('[data-web-ble-scan]');
  if (webBleScan) {
    setButtonBusy(webBleScan, true, 'Opening camera…');
    try {
      await markAttendanceFromWebsite();
    } catch (error) {
      toast(error.message || 'Attendance could not be marked.');
    } finally {
      setButtonBusy(webBleScan, false);
    }
    return;
  }
  const startSession = event.target.closest('[data-start-session]');
  if (startSession) {
    return openStartSessionDialog(startSession.dataset.startSession, startSession.dataset.subject, startSession.dataset.room);
  }
  const manualMark = event.target.closest('[data-manual-mark]');
  if (manualMark) {
    return openManualMarkDialog(manualMark.dataset.manualMark, manualMark.dataset.studentName, manualMark.dataset.current);
  }
  const closeSession = event.target.closest('[data-close-session]');
  if (closeSession) {
    if (!confirm('Close the attendance window now? Every student who has not marked will be recorded absent.')) return;
    setButtonBusy(closeSession, true, 'Closing…');
    try {
      const result = await api(`/api/attendance/sessions/${state.liveSession.id}/close`, { method: 'POST', body: {} });
      stopLivePolling();
      toast(`Session closed. ${result.absentWritten} student${result.absentWritten === 1 ? '' : 's'} recorded absent.`);
      await navigate('live');
    } catch (error) {
      toast(error.message || 'The session could not be closed.');
    } finally {
      setButtonBusy(closeSession, false);
    }
    return;
  }
  if (event.target.closest('[data-add-classroom]')) {
    openModal(`<span class="eyebrow">Classroom registry</span><h2>Add a classroom</h2>
      <form id="classroom-form">
        <div class="field-grid"><label>Room number<input name="roomNumber" required placeholder="210" /></label><label>Building<input name="building" placeholder="Main Academic Block" /></label></div>
        <div class="field-grid"><label>Capacity<input name="capacity" type="number" min="1" placeholder="60" /></label><label>Signal floor (dBm)<input name="minRssi" type="number" min="-127" max="-10" value="-92" /></label></div>
        <button class="primary" type="submit">Add classroom</button>
        <p class="field-note">Calibrate the signal floor from the back bench and from the far side of the shared wall before trusting it.</p>
      </form>`);
    $('#classroom-form').addEventListener('submit', async formEvent => {
      formEvent.preventDefault();
      const button = formEvent.submitter;
      setButtonBusy(button, true, 'Saving…');
      try {
        await api('/api/admin/classrooms', { method: 'POST', body: Object.fromEntries(new FormData(formEvent.target).entries()) });
        closeModal(); toast('Classroom added'); await navigate('classrooms');
      } catch (error) { toast(error.message); } finally { setButtonBusy(button, false); }
    }, { once: true });
    return;
  }
  const addBeacon = event.target.closest('[data-add-beacon]');
  if (addBeacon) {
    const classrooms = await api('/api/admin/classrooms');
    openModal(`<span class="eyebrow">Hardware</span><h2>Provision an ESP32 beacon</h2>
      <form id="beacon-form">
        <label>Beacon code<input name="beaconCode" required placeholder="ATTENDESK-210" /></label>
        <label>Label<input name="label" placeholder="Room 210 beacon" /></label>
        <label>Classroom<select name="classroomId"><option value="">Assign later</option>${classrooms.map(row => `<option value="${row.id}">${escapeHtml(row.room_number)}${row.building ? ` · ${escapeHtml(row.building)}` : ''}</option>`).join('')}</select></label>
        <button class="primary" type="submit">Provision and show key</button>
      </form>`);
    $('#beacon-form').addEventListener('submit', async formEvent => {
      formEvent.preventDefault();
      const button = formEvent.submitter;
      setButtonBusy(button, true, 'Provisioning…');
      try {
        const created = await api('/api/admin/beacons', { method: 'POST', body: Object.fromEntries(new FormData(formEvent.target).entries()) });
        showBeaconKey(created.beacon_code, created.deviceKey);
      } catch (error) { toast(error.message); setButtonBusy(button, false); }
    }, { once: true });
    return;
  }
  const rotateBeacon = event.target.closest('[data-rotate-beacon]');
  if (rotateBeacon) {
    if (!confirm(`Rotate the key for ${rotateBeacon.dataset.beaconCode}? The device stops working until you reflash it.`)) return;
    setButtonBusy(rotateBeacon, true, 'Rotating…');
    try {
      const rotated = await api(`/api/admin/beacons/${rotateBeacon.dataset.rotateBeacon}/rotate-key`, { method: 'POST', body: {} });
      showBeaconKey(rotated.beacon_code, rotated.deviceKey);
    } catch (error) { toast(error.message); } finally { setButtonBusy(rotateBeacon, false); }
    return;
  }
  if (event.target.closest('[data-change-password]')) {
    openModal(`<span class="eyebrow">Account</span><h2>Change your password</h2>
      <form id="password-form">
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" /></label>
        <label>New password<input name="newPassword" type="password" required minlength="8" autocomplete="new-password" /></label>
        <button class="primary" type="submit">Update password</button>
        <p class="field-note">At least 8 characters with both letters and numbers. You will be signed out everywhere else.</p>
      </form>`);
    $('#password-form').addEventListener('submit', async formEvent => {
      formEvent.preventDefault();
      const button = formEvent.submitter;
      setButtonBusy(button, true, 'Updating…');
      try {
        const result = await api('/api/auth/set-password', { method: 'POST', body: Object.fromEntries(new FormData(formEvent.target).entries()) });
        closeModal(); toast(result.message);
      } catch (error) { toast(error.message); } finally { setButtonBusy(button, false); }
    }, { once: true });
    return;
  }
  const peopleButton = event.target.closest('[data-people-role]');
  if (peopleButton) { state.peopleRole = peopleButton.dataset.peopleRole; return navigate('people'); }
  const academicButton = event.target.closest('[data-academic]');
  if (academicButton) { state.academicEntity = academicButton.dataset.academic; return navigate('academic'); }

  const busyControl = event.target.closest('[data-toggle-academic],[data-approve-registration],[data-reject-registration],[data-user-status],[data-approve-device],[data-reject-device],[data-delete-period],[data-view-report],[data-download-report]');
  if (busyControl) setButtonBusy(busyControl, true, 'Working…');
  try {
    const toggleAcademic = event.target.closest('[data-toggle-academic]');
    if (toggleAcademic) {
      const active = toggleAcademic.dataset.active !== 'true';
      const path = toggleAcademic.dataset.entity === 'sections' ? `/api/admin/sections/${toggleAcademic.dataset.toggleAcademic}` : `/api/admin/academic/${toggleAcademic.dataset.entity}/${toggleAcademic.dataset.toggleAcademic}`;
      await api(path, { method: 'PATCH', body: { active } });
      toast(active ? 'Item activated' : 'Item deactivated'); return navigate('academic');
    }
    const approveRegistration = event.target.closest('[data-approve-registration]');
    if (approveRegistration) { await api(`/api/admin/registrations/${approveRegistration.dataset.approveRegistration}/approve`, { method: 'POST', body: {} }); toast('Account approved'); return navigate('registrations'); }
    const rejectRegistration = event.target.closest('[data-reject-registration]');
    if (rejectRegistration) { const reason = prompt('Reason for rejection:'); if (reason) { await api(`/api/admin/registrations/${rejectRegistration.dataset.rejectRegistration}/reject`, { method: 'POST', body: { reason } }); toast('Registration rejected'); return navigate('registrations'); } }
    const barcodeButton = event.target.closest('[data-register-barcode]');
    if (barcodeButton) {
      openModal(`<span class="eyebrow">ID-card registration</span><h2>${barcodeButton.dataset.studentName}</h2><form id="barcode-form"><label>Scan or enter the barcode value<input name="barcode" autofocus required minlength="4" autocomplete="off" /></label><button class="primary">Register securely</button></form>`);
      $('#barcode-form').addEventListener('submit', async formEvent => {
        formEvent.preventDefault();
        const button = formEvent.submitter;
        setButtonBusy(button, true, 'Registering…');
        try {
          const barcode = new FormData(formEvent.target).get('barcode');
          await api(`/api/admin/students/${barcodeButton.dataset.registerBarcode}/barcode`, { method: 'POST', body: { barcode } });
          closeModal(); toast('Barcode registered'); navigate('people');
        } catch (error) { toast(error.message); }
        finally { setButtonBusy(button, false); }
      });
      return;
    }
    const userStatus = event.target.closest('[data-user-status]');
    if (userStatus) {
      const nextStatus = userStatus.dataset.currentStatus === 'active' ? 'suspended' : 'active';
      if (nextStatus === 'suspended' && !confirm('Suspend this account and revoke its signed-in sessions?')) return;
      await api(`/api/admin/users/${userStatus.dataset.userStatus}/status`, { method: 'PATCH', body: { status: nextStatus } });
      toast(nextStatus === 'active' ? 'Account reactivated' : 'Account suspended');
      return navigate('people');
    }
    const approveDevice = event.target.closest('[data-approve-device]');
    if (approveDevice) { await api(`/api/admin/device-change-requests/${approveDevice.dataset.approveDevice}/approve`, { method: 'POST', body: {} }); toast('New phone approved'); return navigate('devices'); }
    const rejectDevice = event.target.closest('[data-reject-device]');
    if (rejectDevice) { await api(`/api/admin/device-change-requests/${rejectDevice.dataset.rejectDevice}/reject`, { method: 'POST', body: {} }); toast('Device request rejected'); return navigate('devices'); }
    const deletePeriod = event.target.closest('[data-delete-period]');
    if (deletePeriod && confirm('Remove this timetable entry?')) { await api(`/api/admin/timetable/${deletePeriod.dataset.deletePeriod}`, { method: 'DELETE' }); toast('Timetable entry removed'); return navigate('timetable'); }
    const viewReport = event.target.closest('[data-view-report]');
    if (viewReport) return renderReportDetail(viewReport.dataset.viewReport);
    const download = event.target.closest('[data-download-report]');
    if (download) return downloadReport(download.dataset.downloadReport, download.dataset.format);
  } catch (error) {
    toast(error.message || 'The action could not be completed.');
  } finally {
    if (busyControl) setButtonBusy(busyControl, false);
  }
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'report-filter-form') {
    event.preventDefault();
    state.reportFilters = Object.fromEntries([...new FormData(event.target).entries()].filter(([, value]) => value));
    return navigate('reports');
  }
  if (event.target.id === 'correction-filter-form') {
    event.preventDefault();
    state.correctionFilters = Object.fromEntries([...new FormData(event.target).entries()].filter(([, value]) => value));
    return navigate('corrections');
  }
  const academic = event.target.dataset.createAcademic;
  const managed = academic || event.target.hasAttribute('data-create-section') || event.target.id === 'timetable-form' || event.target.hasAttribute('data-create-offering') || event.target.hasAttribute('data-enroll-student');
  if (!managed) return;
  event.preventDefault();
  const button = event.submitter;
  setButtonBusy(button, true, 'Saving…');
  try {
    if (academic) {
      const body = Object.fromEntries(new FormData(event.target).entries());
      if (body.number) body.number = Number(body.number);
      if (body.credits) body.credits = Number(body.credits);
      await api(`/api/admin/academic/${academic}`, { method: 'POST', body });
      toast(`${titleCase(academic.slice(0,-1))} added`); return navigate('academic');
    }
    if (event.target.hasAttribute('data-create-section')) {
      await api('/api/admin/sections', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      toast('Section added'); return navigate('academic');
    }
    if (event.target.id === 'timetable-form') {
      const body = Object.fromEntries(new FormData(event.target).entries()); body.dayOfWeek = Number(body.dayOfWeek);
      await api('/api/admin/timetable', { method: 'POST', body }); toast('Timetable period added'); return navigate('timetable');
    }
    if (event.target.hasAttribute('data-create-offering')) {
      await api('/api/admin/offerings', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      toast('Course created'); return navigate('courses');
    }
    if (event.target.hasAttribute('data-enroll-student')) {
      const result = await api('/api/admin/enrollments', { method: 'POST', body: Object.fromEntries(new FormData(event.target).entries()) });
      toast(result.alreadyEnrolled ? 'Student is already on this roster' : 'Student enrolled'); return navigate('courses');
    }
  } catch (error) {
    toast(error.message || 'The form could not be saved.');
  } finally {
    setButtonBusy(button, false);
  }
});

async function downloadReport(id, format) {
  try {
    const params = new URLSearchParams();
    if (state.reportFilters.from) params.set('from', state.reportFilters.from);
    if (state.reportFilters.to) params.set('to', state.reportFilters.to);
    const blob = await api(`/api/reports/offerings/${id}.${format}${params.size ? `?${params}` : ''}`);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `attendance-report.${format}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) { toast(error.message); }
}

$('#menu-button').addEventListener('click', () => {
  const open = !$('.sidebar').classList.contains('open');
  $('.sidebar').classList.toggle('open', open);
  $('#sidebar-backdrop').classList.toggle('open', open);
  $('#menu-button').setAttribute('aria-expanded', String(open));
});
$('#sidebar-close').addEventListener('click', closeMobileNavigation);
$('#sidebar-backdrop').addEventListener('click', closeMobileNavigation);
$('#profile-avatar').addEventListener('click', () => {
  openModal(`<span class="eyebrow">Signed in as</span><h2>${escapeHtml(state.user.full_name)}</h2>
    <p class="modal-copy">${escapeHtml(state.user.email)} · ${titleCase(state.user.role)}</p>
    <div class="stacked-actions">
      ${state.user.role === 'student' ? '' : '<button class="secondary" data-change-password>Change password</button>'}
      <button class="primary" data-action="logout">Log out</button>
    </div>`);
});
document.addEventListener('input', event => {
  if (event.target.id === 'roster-search') {
    state.rosterFilter = event.target.value;
    const list = $('#roster-list');
    if (list && state.liveSession?.roster) list.innerHTML = rosterMarkup(state.liveSession.roster);
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeMobileNavigation(); } });

bindInteractiveDepth(document);
if (state.token && state.user) showApp();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
