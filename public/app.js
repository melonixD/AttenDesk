const state = {
  token: sessionStorage.getItem('attendesk_access') || '',
  refresh: sessionStorage.getItem('attendesk_refresh') || '',
  user: JSON.parse(sessionStorage.getItem('attendesk_user') || 'null'),
  loginEmail: '',
  registrationEmail: '',
  catalog: null,
  page: 'overview',
  peopleRole: 'student',
  academicEntity: 'branches',
  navigationSequence: 0,
  navigationBusy: false,
  pendingPage: null,
  webBleNearby: null
};

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
  const payload = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (response.status === 401 && state.refresh && !retried && path !== '/api/auth/refresh') {
    const refreshed = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refresh }) });
    if (refreshed.ok) {
      const session = await refreshed.json();
      state.token = session.accessToken;
      state.refresh = session.refreshToken;
      sessionStorage.setItem('attendesk_access', state.token);
      sessionStorage.setItem('attendesk_refresh', state.refresh);
      return api(path, options, true);
    }
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
  $$('.metric, .panel, .action-card, .workspace-chip, .signal-art', root).forEach(surface => {
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
      body: { email: state.loginEmail, code: $('#login-otp').value, clientType: 'web_ble', installationId: installationId(), deviceName: browserDeviceName(), platform: 'web' }
    });
    state.token = result.accessToken;
    state.refresh = result.refreshToken;
    state.user = result.user;
    sessionStorage.setItem('attendesk_access', state.token);
    sessionStorage.setItem('attendesk_refresh', state.refresh);
    sessionStorage.setItem('attendesk_user', JSON.stringify(state.user));
    showApp();
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
    ['overview', 'home', 'Overview'], ['registrations', 'check', 'Approvals'], ['people', 'users', 'People'], ['academic', 'building', 'Academic setup'], ['courses', 'book', 'Courses'], ['timetable', 'calendar', 'Timetable'], ['devices', 'phone', 'Device requests'], ['reports', 'chart', 'Reports'], ['security', 'shield', 'Security & backups']
  ],
  teacher: [['overview', 'home', 'Overview'], ['classes', 'book', 'My classes'], ['reports', 'chart', 'Attendance reports']],
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
  if (page === 'devices') return renderDevices();
  if (page === 'reports') return renderReports();
  if (page === 'security') return renderSecurity();
}

async function renderAdminOverview() {
  heading('Administration', 'College overview');
  const data = await api('/api/admin/overview');
  $('#page-content').innerHTML = `
    <section class="metrics">
      ${metric(data.students, 'Students', 'Active academic records', true)}${metric(data.teachers, 'Teachers', 'Approved faculty')}${metric(data.registrations, 'Pending accounts', 'Needs review')}${metric(data.sessions_today, 'Sessions today', 'Across all classes')}
    </section>
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
  $('#page-content').innerHTML = `<div class="tab-row"><button class="tab ${state.peopleRole === 'student' ? 'active' : ''}" data-people-role="student">Students</button><button class="tab ${state.peopleRole === 'teacher' ? 'active' : ''}" data-people-role="teacher">Teachers</button></div><article class="panel"><div class="panel-header"><div><span class="eyebrow">Approved accounts</span><h2>${titleCase(state.peopleRole)} directory</h2></div><span class="pill">${rows.length} records</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Person</th><th>Identifier</th><th>Academic assignment</th><th>${state.peopleRole === 'student' ? 'ID and device' : 'Status'}</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td><div class="person"><span class="person-avatar">${escapeHtml(row.full_name[0])}</span><div><strong>${escapeHtml(row.full_name)}</strong><br /><small>${escapeHtml(row.email)}</small></div></div></td><td>${escapeHtml(row.roll_number || row.employee_code)}</td><td>${escapeHtml([row.branch, row.semester && `Sem ${row.semester}`, row.section && `Section ${row.section}`].filter(Boolean).join(' · ') || '—')}</td><td>${state.peopleRole === 'student' ? `${row.barcode_status ? `Barcode ••••${escapeHtml(row.barcode_last_four)}` : '<span class="warning-text">No barcode</span>'}<br /><small>${escapeHtml(row.device_name || 'No device')} · ${titleCase(row.status)}</small>` : titleCase(row.status)}</td><td>${state.peopleRole === 'student' ? `<button class="table-action" data-register-barcode="${row.id}" data-student-name="${escapeHtml(row.full_name)}">Register barcode</button> ` : ''}<button class="table-action ${row.status==='active'?'danger':''}" data-user-status="${row.id}" data-current-status="${row.status}">${row.status==='active'?'Suspend':'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div></article>`;
}

async function renderAcademic() {
  heading('Academic setup', 'College structure');
  const entity = state.academicEntity;
  const rows = entity === 'sections' ? await api('/api/admin/sections') : await api(`/api/admin/academic/${entity}`);
  const catalogs = await Promise.all([api('/api/admin/academic/branches'), api('/api/admin/academic/semesters')]);
  const form = academicForm(entity, catalogs[0], catalogs[1]);
  $('#page-content').innerHTML = `<div class="tab-row">${['branches','semesters','subjects','sections'].map(item => `<button class="tab ${item === entity ? 'active' : ''}" data-academic="${item}">${titleCase(item)}</button>`).join('')}</div><article class="panel"><div class="panel-header"><div><span class="eyebrow">Create and manage</span><h2>${titleCase(entity)}</h2></div><span class="pill">${rows.length} configured</span></div>${form}</article><article class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Code / period</th><th>Assignment</th><th>Status</th><th>Manage</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.name || `Semester ${row.number}`)}</strong></td><td>${escapeHtml(row.code || (row.academic_year ? `${row.academic_year} · ${row.term}` : '—'))}</td><td>${escapeHtml([row.branch_name, row.semester_number && `Semester ${row.semester_number}`].filter(Boolean).join(' · ') || '—')}</td><td><span class="pill">${row.active === false ? 'Inactive' : 'Active'}</span></td><td><button class="table-action" data-toggle-academic="${row.id}" data-entity="${entity}" data-active="${row.active !== false}">${row.active === false ? 'Activate' : 'Deactivate'}</button></td></tr>`).join('')}</tbody></table></div></article>`;
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
  $('#page-content').innerHTML = `<section class="split"><article class="panel"><div class="panel-header"><div><span class="eyebrow">New course</span><h2>Assign a subject</h2></div></div><form class="compact-form" data-create-offering><label>Subject<select name="subjectId">${subjects.filter(row=>row.active).map(row=>`<option value="${row.id}">${escapeHtml(row.code)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Teacher<select name="teacherId">${teachers.map(row=>`<option value="${row.id}">${escapeHtml(row.full_name)}</option>`).join('')}</select></label><label>Section<select name="sectionId">${sections.filter(row=>row.active).map(row=>`<option value="${row.id}">${escapeHtml(row.branch_code)} · Sem ${row.semester_number} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Semester<select name="semesterId">${semesters.filter(row=>row.active).map(row=>`<option value="${row.id}">Semester ${row.number} · ${escapeHtml(row.academic_year)}</option>`).join('')}</select></label><label>Default room<input name="defaultRoom" placeholder="210" required /></label><button class="primary">Create course</button></form></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Roster</span><h2>Enroll a student</h2></div></div><form class="compact-form" data-enroll-student><label>Course<select name="offeringId">${courseOptions}</select></label><label>Student<select name="studentId">${students.map(row=>`<option value="${row.id}">${escapeHtml(row.roll_number)} · ${escapeHtml(row.full_name)}</option>`).join('')}</select></label><button class="primary">Add to roster</button></form></article></section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Current semester</span><h2>Course offerings</h2></div><span class="pill">${offerings.length} courses</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Teacher</th><th>Class</th><th>Semester</th><th>Room</th></tr></thead><tbody>${offerings.map(row=>`<tr><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.subject_code)}</small></td><td>${escapeHtml(row.teacher)}</td><td>${escapeHtml(row.branch)} · Section ${escapeHtml(row.section)}</td><td>${row.semester}</td><td>${escapeHtml(row.default_room)}</td></tr>`).join('')}</tbody></table></div></article>`;
}

async function renderTimetable() {
  heading('Scheduling', 'Timetable management');
  const [entries, offerings] = await Promise.all([api('/api/admin/timetable'), api('/api/admin/offerings')]);
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">New class period</span><h2>Add timetable entry</h2></div></div><form class="compact-form" id="timetable-form"><label>Class<select name="offeringId">${offerings.map(row => `<option value="${row.id}">${escapeHtml(row.subject)} · ${escapeHtml(row.branch)} ${escapeHtml(row.section)}</option>`).join('')}</select></label><label>Day<select name="dayOfWeek">${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((day,index)=>`<option value="${index+1}">${day}</option>`).join('')}</select></label><label>Room<input name="room" required /></label><label>Starts<input name="startsAt" type="time" required /></label><label>Ends<input name="endsAt" type="time" required /></label><label>Valid from<input name="validFrom" type="date" required /></label><label>Valid until<input name="validUntil" type="date" required /></label><button class="primary">Add period</button></form></article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Weekly plan</span><h2>Configured periods</h2></div><span class="pill">${entries.length} entries</span></div>${entries.map(row=>`<div class="schedule-row timetable-row"><span class="day">${['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'][row.day_of_week]}</span><strong>${escapeHtml(row.subject)}</strong><span>${escapeHtml(row.branch)} · ${escapeHtml(row.section)}</span><span>${String(row.starts_at).slice(0,5)}</span><button class="table-action danger" data-delete-period="${row.id}">Remove</button></div>`).join('') || '<div class="empty">No timetable entries yet.</div>'}</article>`;
}

async function renderDevices() {
  heading('Device security', 'Phone change requests');
  const rows = await api('/api/admin/device-change-requests');
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">One phone per student</span><h2>Replacement approvals</h2></div><span class="pill warn">${rows.filter(row=>row.status==='pending').length} pending</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Current phone</th><th>Requested phone</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows.map(row=>`<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.roll_number)}</small></td><td>${escapeHtml(row.old_device_name || 'None')}</td><td>${escapeHtml(row.requested_device_name)}</td><td>${escapeHtml(row.reason)}</td><td>${row.status==='pending'?`<button class="table-action" data-approve-device="${row.id}">Approve</button> <button class="table-action danger" data-reject-device="${row.id}">Reject</button>`:`<span class="pill">${titleCase(row.status)}</span>`}</td></tr>`).join('') || emptyTableRow('No device-change requests.', 5)}</tbody></table></div></article>`;
}

async function renderReports() {
  heading('Attendance intelligence', 'Reports and defaulters');
  const offerings = state.user.role === 'admin' ? await api('/api/admin/offerings') : await api('/api/teacher/classes');
  $('#page-content').innerHTML = `<article class="panel"><div class="panel-header"><div><span class="eyebrow">Subject-wise records</span><h2>Download attendance</h2></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Class</th><th>Room</th><th>Exports</th></tr></thead><tbody>${offerings.map(row=>`<tr><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.code || row.subject_code)}</small></td><td>${escapeHtml(row.branch)} · Section ${escapeHtml(row.section)}</td><td>${escapeHtml(row.default_room)}</td><td><div class="report-actions"><button class="table-action" data-download-report="${row.id}" data-format="xlsx">Excel</button><button class="table-action" data-download-report="${row.id}" data-format="pdf">PDF</button><button class="table-action" data-view-report="${row.id}">View</button></div></td></tr>`).join('') || emptyTableRow('No course reports are available yet.', 4)}</tbody></table></div></article>`;
}

async function renderReportDetail(id) {
  const data = await api(`/api/reports/offerings/${id}`);
  openModal(`<span class="eyebrow">Below ${data.threshold}% highlighted</span><h2>${escapeHtml(data.offering.subject_name)}</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Attended</th><th>Conducted</th><th>Percentage</th></tr></thead><tbody>${data.rows.map(row=>`<tr><td><strong>${escapeHtml(row.full_name)}</strong><br/><small>${escapeHtml(row.roll_number)}</small></td><td>${row.attended}</td><td>${row.conducted}</td><td class="${row.below_threshold?'warning-text':''}"><strong>${row.percentage}%</strong></td></tr>`).join('')}</tbody></table></div>`);
}

async function renderSecurity() {
  heading('Trust and recovery', 'Security & backups');
  const [audit, backups] = await Promise.all([api('/api/admin/audit'), api('/api/admin/backups')]);
  $('#page-content').innerHTML = `<section class="metrics">${metric('OTP','Login','Passwordless college email',true)}${metric('15 min','Access token','Short-lived authentication')}${metric(audit.length,'Audit events','Latest 500 shown')}${metric(backups.filter(row=>row.status==='succeeded').length,'Backups','Successful recorded runs')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Immutable history</span><h2>Recent audit events</h2></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead><tbody>${audit.slice(0,50).map(row=>`<tr><td>${new Date(row.created_at).toLocaleString()}</td><td>${escapeHtml(row.actor || 'System')}</td><td>${titleCase(row.action)}</td><td>${escapeHtml(row.entity_type)}</td><td><small>${escapeHtml(row.request_id)}</small></td></tr>`).join('') || emptyTableRow('No audit activity has been recorded yet.', 5)}</tbody></table></div></article><article class="panel backup-panel"><div class="panel-header"><div><span class="eyebrow">Recovery</span><h2>Database backups</h2></div><span class="pill">30-day local retention</span></div>${backups.length?backups.map(row=>`<div class="schedule-row backup-row"><span>${new Date(row.started_at).toLocaleDateString()}</span><strong>${titleCase(row.status)}</strong><span>${escapeHtml(row.storage_path||'—')}</span><span>${row.size_bytes||'—'}</span><span></span></div>`).join(''):'<p class="empty">No backup run has been recorded yet. Schedule server/scripts/backup.sh daily.</p>'}</article>`;
}

async function renderTeacherPage(page) {
  if (page === 'reports') return renderReports();
  const classes = await api('/api/teacher/classes');
  const threshold = classes[0]?.attendance_threshold ?? '—';
  heading('Teacher workspace', page === 'classes' ? 'Your assigned classes' : `${greeting()}, ${state.user.full_name.split(' ')[0]}.`);
  $('#page-content').innerHTML = `<section class="metrics">${metric(classes.length,'Assigned classes','Current semester',true)}${metric(`${threshold}%`,'Required attendance','College threshold')}${metric('BLE','Attendance method','Barcode verified')}${metric('Live','Roster updates','Every two seconds')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Current semester</span><h2>Classes and reports</h2></div></div>${classes.map(row=>`<div class="schedule-row teacher-class-row"><span class="day">${escapeHtml(row.code)}</span><strong>${escapeHtml(row.subject)}</strong><span>${escapeHtml(row.branch)} · ${escapeHtml(row.section)}</span><span>Room ${escapeHtml(row.default_room)}</span><button class="table-action" data-view-report="${row.id}">Report</button></div>`).join('') || '<div class="empty">No classes are assigned yet.</div>'}</article><article class="panel app-callout"><span>${icon('phone',20)}</span><div><strong>Teacher Beacon companion required</strong><p>Start the timed class from the Android teacher app. It hosts the secure BLE service that Chrome students connect to; reports and corrections remain available here.</p></div><i>${icon('arrow',18)}</i></article>`;
}

function webBluetoothCardMarkup() {
  if (!webBluetoothSupported()) {
    return `<article id="web-bluetooth-card" class="panel ble-discovery-panel"><div class="panel-header"><div><span class="eyebrow">Bluetooth attendance</span><h2>This browser cannot scan the classroom beacon</h2></div><span class="pill warn">Unsupported</span></div><p class="ble-explainer">Open this HTTPS website in Chrome on an Android phone. Safari on iPhone and Firefox do not provide the Web Bluetooth connection required by Attendesk.</p></article>`;
  }
  const nearby = state.webBleNearby;
  if (nearby) {
    return `<article id="web-bluetooth-card" class="panel ble-discovery-panel ble-found"><div class="panel-header"><div><span class="eyebrow"><i class="eyebrow-dot"></i>Classroom beacon connected</span><h2>Available attendance</h2></div><span class="pill">Bluetooth verified</span></div><div class="ble-bubble-wrap"><button class="ble-class-bubble" data-web-ble-scan><span>ROOM ${escapeHtml(nearby.session.room)}</span><strong>${escapeHtml(nearby.session.subject)}</strong><small>${escapeHtml(nearby.session.teacher)} · ${escapeHtml(nearby.session.branch)} ${escapeHtml(nearby.session.section)}</small><b>Scan ID card</b></button><div class="ble-orbit orbit-a"></div><div class="ble-orbit orbit-b"></div></div><p class="ble-explainer">Connected through ${escapeHtml(nearby.deviceName || 'the teacher beacon')}. Keep Bluetooth on and scan the printed barcode on your own college ID.</p><button class="text-button left" data-web-ble-connect>Choose a different beacon</button></article>`;
  }
  return `<article id="web-bluetooth-card" class="panel ble-discovery-panel"><div class="panel-header"><div><span class="eyebrow">Bluetooth attendance</span><h2>Find your teacher's class</h2></div><span class="pill">Chrome · Android</span></div><div class="ble-ready"><span class="ble-symbol">${icon('bluetooth',28)}</span><div><strong>Bluetooth is requested only after you tap.</strong><p>The browser will show nearby Attendesk teacher beacons. Select the beacon in your classroom.</p></div><button class="primary ble-connect-button" data-web-ble-connect>Find nearby class</button></div><p class="ble-explainer">Requires HTTPS, Bluetooth enabled, Chrome on Android, and the teacher's Beacon companion app broadcasting an active session.</p></article>`;
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
    state.webBleNearby = { session, token, deviceName: device.name || 'Attendesk teacher beacon' };
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
  const [data, history] = await Promise.all([api('/api/student/dashboard'), api('/api/student/history')]);
  const overallStatus = data.conducted === 0 ? 'No classes yet' : data.overallPercentage >= data.threshold ? 'On track' : 'Action needed';
  const overallWarning = data.conducted > 0 && data.overallPercentage < data.threshold;
  $('#page-content').innerHTML = `<section class="metrics">${metric(`${data.overallPercentage}%`,'Overall attendance',`${data.attended} of ${data.conducted} classes`,true)}${metric(data.subjects.length,'Subjects','Current enrollments')}${metric(data.subjects.filter(row=>row.belowThreshold).length,'Below threshold',`Required ${data.threshold}%`)}${metric('Web BLE','Marking access','Chrome on registered Android')}</section>${webBluetoothCardMarkup()}<article class="panel"><div class="panel-header"><div><span class="eyebrow">Subject-wise attendance</span><h2>Your complete record</h2></div><span class="pill ${overallWarning?'warn':''}">${overallStatus}</span></div>${data.subjects.map(row=>`<div class="schedule-row attendance-row"><span class="person-avatar">${escapeHtml(row.subject_code.slice(0,2))}</span><div><strong>${escapeHtml(row.subject)}</strong><div class="subject-progress"><i style="width:${Math.min(100,row.percentage)}%"></i></div></div><span>${row.attended} / ${row.conducted}</span><strong class="${row.belowThreshold?'warning-text':''}">${row.percentage}%</strong><span>${row.conducted===0?'Not started':row.belowThreshold?`Below ${data.threshold}%`:'On track'}</span></div>`).join('') || '<div class="empty">No subjects have been assigned yet.</div>'}</article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Attendance history</span><h2>Recent classes</h2></div><span class="pill">${history.length} records</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Subject</th><th>Teacher</th><th>Room</th><th>Status</th></tr></thead><tbody>${history.map(row=>`<tr><td>${escapeHtml(new Date(row.starts_at).toLocaleString())}</td><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.subject_code)}</small></td><td>${escapeHtml(row.teacher)}</td><td>${escapeHtml(row.room)}</td><td><span class="pill ${row.status==='absent'?'warn':''}">${titleCase(row.status)}</span></td></tr>`).join('') || emptyTableRow('No completed classes yet.', 5)}</tbody></table></div></article>`;
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

document.addEventListener('click', async event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) return navigate(pageButton.dataset.page);
  const retryButton = event.target.closest('[data-retry-page]');
  if (retryButton) return navigate(retryButton.dataset.retryPage);
  if (event.target.closest('[data-action="logout"]')) {
    if (state.refresh) await api('/api/auth/logout', { method: 'POST', body: { refreshToken: state.refresh } }).catch(() => null);
    sessionStorage.clear(); state.token = ''; state.refresh = ''; state.user = null; location.reload(); return;
  }
  if (event.target.closest('[data-action="close-modal"]')) return closeModal();
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
    const blob = await api(`/api/reports/offerings/${id}.${format}`);
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
$('#profile-avatar').addEventListener('click', async () => { if (confirm('Log out of AttenDesk?')) { if (state.refresh) await api('/api/auth/logout', { method: 'POST', body: { refreshToken: state.refresh } }).catch(() => null); sessionStorage.clear(); location.reload(); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeMobileNavigation(); } });

bindInteractiveDepth(document);
if (state.token && state.user) showApp();
