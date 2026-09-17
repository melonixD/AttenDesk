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
  pendingPage: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const titleCase = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());

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
  requestAnimationFrame(() => content.classList.add('page-ready'));
}

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
      body: { email: state.loginEmail, code: $('#login-otp').value, clientType: 'web' }
    });
    state.token = result.accessToken;
    state.refresh = result.refreshToken;
    state.user = result.user;
    sessionStorage.setItem('attendesk_access', state.token);
    sessionStorage.setItem('attendesk_refresh', state.refresh);
    sessionStorage.setItem('attendesk_user', JSON.stringify(state.user));
    showApp();
  } catch (error) {
    message('#auth-message', error.code === 'DEVICE_CHANGE_REQUIRED' ? 'This student account is linked to another device. Submit a device-change request from the Android app.' : error.message, true);
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
    ['overview', '◫', 'Overview'], ['registrations', '✓', 'Approvals'], ['people', '♙', 'People'], ['academic', '◇', 'Academic setup'], ['courses', '▤', 'Courses'], ['timetable', '▦', 'Timetable'], ['devices', '⌁', 'Device requests'], ['reports', '↗', 'Reports'], ['security', '⌾', 'Security & backups']
  ],
  teacher: [['overview', '◫', 'Overview'], ['classes', '▦', 'My classes'], ['reports', '↗', 'Attendance reports']],
  student: [['overview', '◫', 'My attendance']]
};

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#profile-name').textContent = state.user.full_name;
  $('#profile-role').textContent = state.user.role;
  $('#profile-avatar').textContent = state.user.full_name.split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
  $('#nav').innerHTML = navByRole[state.user.role].map(([page, icon, label]) => `<button class="nav-button ${page === state.page ? 'active' : ''}" data-page="${page}"><span>${icon}</span>${label}</button>`).join('') + '<button class="nav-button" data-action="logout"><span>↪</span>Log out</button>';
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
        <div class="action-grid"><button class="action-card" data-page="registrations"><strong>${data.registrations} registration requests</strong><small>Verify student and teacher details</small></button><button class="action-card" data-page="devices"><strong>${data.device_requests} device changes</strong><small>Review phone replacement requests</small></button><button class="action-card" data-page="academic"><strong>Academic structure</strong><small>Branches, subjects and semesters</small></button></div>
      </article>
      <article class="panel"><div class="panel-header"><div><span class="eyebrow">System</span><h2>Production controls</h2></div></div><p class="empty">OTP login active<br />Audit logging active<br />Database persistence active</p></article>
    </section>`;
}

const metric = (value, label, note, dark = false) => `<article class="metric ${dark ? 'dark' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;

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
  $('#page-content').innerHTML = `<section class="metrics">${metric('OTP','Login','Passwordless college email',true)}${metric('15 min','Access token','Short-lived authentication')}${metric(audit.length,'Audit events','Latest 500 shown')}${metric(backups.filter(row=>row.status==='succeeded').length,'Backups','Successful recorded runs')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Immutable history</span><h2>Recent audit events</h2></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead><tbody>${audit.slice(0,50).map(row=>`<tr><td>${new Date(row.created_at).toLocaleString()}</td><td>${escapeHtml(row.actor || 'System')}</td><td>${titleCase(row.action)}</td><td>${escapeHtml(row.entity_type)}</td><td><small>${escapeHtml(row.request_id)}</small></td></tr>`).join('') || emptyTableRow('No audit activity has been recorded yet.', 5)}</tbody></table></div></article><article class="panel danger-zone"><div class="panel-header"><div><span class="eyebrow">Recovery</span><h2>Database backups</h2></div><span class="pill">30-day local retention</span></div>${backups.length?backups.map(row=>`<div class="schedule-row backup-row"><span>${new Date(row.started_at).toLocaleDateString()}</span><strong>${titleCase(row.status)}</strong><span>${escapeHtml(row.storage_path||'—')}</span><span>${row.size_bytes||'—'}</span><span></span></div>`).join(''):'<p class="empty">No backup run has been recorded yet. Schedule server/scripts/backup.sh daily.</p>'}</article>`;
}

async function renderTeacherPage(page) {
  if (page === 'reports') return renderReports();
  const classes = await api('/api/teacher/classes');
  const threshold = classes[0]?.attendance_threshold ?? '—';
  heading('Teacher workspace', page === 'classes' ? 'Your assigned classes' : `Good morning, ${state.user.full_name.split(' ')[0]}.`);
  $('#page-content').innerHTML = `<section class="metrics">${metric(classes.length,'Assigned classes','Current semester',true)}${metric(`${threshold}%`,'Required attendance','College threshold')}${metric('BLE','Attendance method','Barcode verified')}${metric('Live','Roster updates','Every two seconds')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Current semester</span><h2>Classes and reports</h2></div></div>${classes.map(row=>`<div class="schedule-row teacher-class-row"><span class="day">${escapeHtml(row.code)}</span><strong>${escapeHtml(row.subject)}</strong><span>${escapeHtml(row.branch)} · ${escapeHtml(row.section)}</span><span>Room ${escapeHtml(row.default_room)}</span><button class="table-action" data-view-report="${row.id}">Report</button></div>`).join('') || '<div class="empty">No classes are assigned yet.</div>'}</article><article class="panel"><p class="empty">Start Bluetooth attendance from the Android teacher app. This website is used for records, corrections and reports.</p></article>`;
}

async function renderStudentPage() {
  heading('Student dashboard', `Hello, ${state.user.full_name.split(' ')[0]}.`);
  const [data, history] = await Promise.all([api('/api/student/dashboard'), api('/api/student/history')]);
  const overallStatus = data.conducted === 0 ? 'No classes yet' : data.overallPercentage >= data.threshold ? 'On track' : 'Action needed';
  const overallWarning = data.conducted > 0 && data.overallPercentage < data.threshold;
  $('#page-content').innerHTML = `<section class="metrics">${metric(`${data.overallPercentage}%`,'Overall attendance',`${data.attended} of ${data.conducted} classes`,true)}${metric(data.subjects.length,'Subjects','Current enrollments')}${metric(data.subjects.filter(row=>row.belowThreshold).length,'Below threshold',`Required ${data.threshold}%`)}${metric('Mobile only','Marking access','Registered Android phone')}</section><article class="panel"><div class="panel-header"><div><span class="eyebrow">Subject-wise attendance</span><h2>Your complete record</h2></div><span class="pill ${overallWarning?'warn':''}">${overallStatus}</span></div>${data.subjects.map(row=>`<div class="schedule-row attendance-row"><span class="person-avatar">${escapeHtml(row.subject_code.slice(0,2))}</span><div><strong>${escapeHtml(row.subject)}</strong><div class="subject-progress"><i style="width:${Math.min(100,row.percentage)}%"></i></div></div><span>${row.attended} / ${row.conducted}</span><strong class="${row.belowThreshold?'warning-text':''}">${row.percentage}%</strong><span>${row.conducted===0?'Not started':row.belowThreshold?`Below ${data.threshold}%`:'On track'}</span></div>`).join('') || '<div class="empty">No subjects have been assigned yet.</div>'}</article><article class="panel"><div class="panel-header"><div><span class="eyebrow">Attendance history</span><h2>Recent classes</h2></div><span class="pill">${history.length} records</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Subject</th><th>Teacher</th><th>Room</th><th>Status</th></tr></thead><tbody>${history.map(row=>`<tr><td>${escapeHtml(new Date(row.starts_at).toLocaleString())}</td><td><strong>${escapeHtml(row.subject)}</strong><br/><small>${escapeHtml(row.subject_code)}</small></td><td>${escapeHtml(row.teacher)}</td><td>${escapeHtml(row.room)}</td><td><span class="pill ${row.status==='absent'?'warn':''}">${titleCase(row.status)}</span></td></tr>`).join('') || emptyTableRow('No completed classes yet.', 5)}</tbody></table></div></article>`;
}

function openModal(html) { $('#modal-content').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }

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

if (state.token && state.user) showApp();
