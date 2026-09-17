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
const screens = { role: $('#role-screen'), teacher: $('#teacher-screen'), student: $('#student-screen') };
let selectedMinutes = 3;
let remaining = 180;
let totalSeconds = 180;
let timerId = null;
let manualStudentId = null;

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => node.classList.toggle('hidden', key !== name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

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
