const students = [
  { id: 1, name: 'Aarav Verma', roll: '240101', present: true, method: 'Bluetooth + ID' },
  { id: 2, name: 'Ananya Gupta', roll: '240102', present: false },
  { id: 3, name: 'Arjun Yadav', roll: '240103', present: true, method: 'Bluetooth + ID' },
  { id: 4, name: 'Diya Sharma', roll: '240104', present: true, method: 'Bluetooth + ID' },
  { id: 5, name: 'Ishaan Mishra', roll: '240105', present: false },
  { id: 6, name: 'Kavya Tiwari', roll: '240106', present: false },
  { id: 7, name: 'Rohan Patel', roll: '240107', present: false },
  { id: 8, name: 'Saanvi Khan', roll: '240108', present: false }
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const screens = { role: $('#role-screen'), teacher: $('#teacher-screen'), student: $('#student-screen') };
let selectedMinutes = 3;
let remaining = 180;
let totalSeconds = 180;
let timerId = null;
let manualStudentId = null;

function showScreen(name) {
  const update = () => Object.entries(screens).forEach(([key, node]) => node.classList.toggle('hidden', key !== name));
  if (document.startViewTransition && !motionPreference.matches) document.startViewTransition(update);
  else update();
  requestAnimationFrame(() => {
    bindInteractiveDepth(screens[name]);
    animateVisibleNumbers(screens[name]);
    window.scrollTo({ top: 0, behavior: motionPreference.matches ? 'auto' : 'smooth' });
  });
}

function bindInteractiveDepth(root = document) {
  if (motionPreference.matches || !finePointer.matches) return;
  $$('.role-card, .metric-card, .panel, .subject-card, .attendance-ring-card', root).forEach(surface => {
    if (surface.dataset.depthBound) return;
    surface.dataset.depthBound = 'true';
    surface.classList.add('depth-surface');
    surface.addEventListener('pointermove', event => {
      const bounds = surface.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      surface.style.setProperty('--surface-rx', `${(0.5 - y) * 3.5}deg`);
      surface.style.setProperty('--surface-ry', `${(x - 0.5) * 3.5}deg`);
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

function animateVisibleNumbers(root) {
  if (motionPreference.matches) return;
  $$('.metric-card strong, .ring strong', root).forEach((node, index) => {
    const original = node.textContent.trim();
    const match = original.match(/^([\d.]+)(.*)$/);
    if (!match) return;
    const target = Number(match[1]);
    const decimals = (match[1].split('.')[1] || '').length;
    const suffix = match[2];
    const padded = /^0\d/.test(match[1]);
    const started = performance.now() + index * 65;
    const update = now => {
      const progress = Math.max(0, Math.min(1, (now - started) / 900));
      const value = target * (1 - Math.pow(1 - progress, 4));
      let label = decimals ? value.toFixed(decimals) : String(Math.round(value));
      if (padded) label = label.padStart(match[1].length, '0');
      node.textContent = `${label}${suffix}`;
      if (progress < 1) requestAnimationFrame(update);
      else node.textContent = original;
    };
    requestAnimationFrame(update);
  });
}

let pointerFrame = 0;
window.addEventListener('pointermove', event => {
  if (motionPreference.matches || !finePointer.matches || pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    const x = event.clientX / innerWidth - 0.5;
    const y = event.clientY / innerHeight - 0.5;
    document.documentElement.style.setProperty('--cursor-x', `${event.clientX}px`);
    document.documentElement.style.setProperty('--cursor-y', `${event.clientY}px`);
    document.documentElement.style.setProperty('--scene-x', `${x * 26}px`);
    document.documentElement.style.setProperty('--scene-y', `${y * 20}px`);
    document.documentElement.style.setProperty('--scene-inverse-x', `${x * -18}px`);
    document.documentElement.style.setProperty('--scene-inverse-y', `${y * -14}px`);
    document.documentElement.style.setProperty('--scene-rx', `${y * -4.2}deg`);
    document.documentElement.style.setProperty('--scene-ry', `${x * 4.2}deg`);
    pointerFrame = 0;
  });
}, { passive: true });

const bubbleStage = $('.bubble-stage');
bubbleStage?.addEventListener('pointermove', event => {
  if (motionPreference.matches || !finePointer.matches) return;
  const bounds = bubbleStage.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - 0.5;
  const y = (event.clientY - bounds.top) / bounds.height - 0.5;
  bubbleStage.style.setProperty('--bubble-x', `${x * 14}px`);
  bubbleStage.style.setProperty('--bubble-y', `${y * 10}px`);
  bubbleStage.style.setProperty('--bubble-rx', `${-y * 7}deg`);
  bubbleStage.style.setProperty('--bubble-ry', `${x * 7}deg`);
}, { passive: true });
bubbleStage?.addEventListener('pointerleave', () => {
  for (const name of ['--bubble-x', '--bubble-y', '--bubble-rx', '--bubble-ry']) bubbleStage.style.removeProperty(name);
});

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2100);
}

function renderRoster() {
  $('#roster-list').innerHTML = students.map(student => `
    <div class="roster-row">
      <span class="student-avatar">${student.name[0]}</span>
      <div><strong>${student.name}</strong><small>${student.roll}${student.method ? ` · ${student.method}` : ''}</small></div>
      <button class="status-check ${student.present ? 'present' : ''}" data-manual="${student.id}" aria-label="Change ${student.name}'s attendance">${student.present ? '✓' : '+'}</button>
    </div>`).join('');
  const count = students.filter(item => item.present).length;
  $('#present-count').textContent = count;
  $('#pending-count').textContent = students.length - count;
  requestAnimationFrame(() => bindInteractiveDepth($('#teacher-screen')));
}

function updateTimer() {
  const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
  const secs = String(remaining % 60).padStart(2, '0');
  $('#timer-value').textContent = `${mins}:${secs}`;
  $('#timer-progress').style.width = `${Math.max(0, remaining / totalSeconds) * 100}%`;
  if (remaining <= 0) endSession('Attendance window closed automatically');
  remaining -= 1;
}

function startSession() {
  $('#teacher-ready').classList.add('hidden');
  $('#live-session').classList.remove('hidden');
  totalSeconds = selectedMinutes * 60;
  remaining = totalSeconds;
  renderRoster();
  clearInterval(timerId);
  updateTimer();
  timerId = setInterval(updateTimer, 1000);
  toast('Bluetooth attendance is live');
  $('#live-session').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function endSession(message = 'Attendance session ended') {
  clearInterval(timerId);
  timerId = null;
  remaining = Math.max(0, remaining);
  $('#timer-value').textContent = 'Closed';
  $('#timer-progress').style.width = '0%';
  toast(message);
}

$$('[data-role]').forEach(button => button.addEventListener('click', () => showScreen(button.dataset.role)));
$$('[data-action="switch-role"], [data-action="role-menu"]').forEach(button => button.addEventListener('click', () => showScreen('role')));
$('[data-action="home"]').addEventListener('click', () => showScreen('role'));
$$('[data-minutes]').forEach(button => button.addEventListener('click', () => {
  $$('[data-minutes]').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  selectedMinutes = Number(button.dataset.minutes);
}));
$('[data-action="start-session"]').addEventListener('click', startSession);
$('[data-action="end-session"]').addEventListener('click', () => endSession());
$('[data-action="extend"]').addEventListener('click', () => {
  remaining += 60;
  totalSeconds += 60;
  toast('Attendance extended by 1 minute');
});
$('[data-action="open-session"]').addEventListener('click', () => $('#scanner-modal').classList.remove('hidden'));
$('[data-action="close-scanner"]').addEventListener('click', () => $('#scanner-modal').classList.add('hidden'));
$('[data-action="simulate-scan"]').addEventListener('click', () => {
  $('#scanner-modal').classList.add('hidden');
  $('#success-modal').classList.remove('hidden');
});
$('[data-action="close-success"]').addEventListener('click', () => $('#success-modal').classList.add('hidden'));
$('[data-action="close-manual"]').addEventListener('click', () => $('#manual-modal').classList.add('hidden'));
$('[data-action="confirm-manual"]').addEventListener('click', () => {
  const student = students.find(item => item.id === manualStudentId);
  student.present = true;
  student.method = `Manual · ${$('#manual-reason').value}`;
  $('#manual-modal').classList.add('hidden');
  renderRoster();
  toast(`${student.name} marked present manually`);
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-manual]');
  if (!button) return;
  const student = students.find(item => item.id === Number(button.dataset.manual));
  if (student.present) {
    student.present = false;
    student.method = null;
    renderRoster();
    toast(`${student.name} changed to absent`);
    return;
  }
  manualStudentId = student.id;
  $('#manual-name').textContent = student.name;
  $('#manual-modal').classList.remove('hidden');
});

renderRoster();
bindInteractiveDepth(document);
animateVisibleNumbers($('#role-screen'));
