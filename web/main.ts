import './style.css';
import { Conversations } from './chat';
let chat: Conversations | undefined;
type Device = {
  id: string;
  name: string;
  platform: string;
  root: string;
  online: boolean;
  capabilities: string[];
  lastSeen: number;
  hostname: string;
};
type Task = {
  id: string;
  deviceId: string;
  input: string;
  executor: string;
  cwd: string;
  sessionId: string;
  status: string;
  createdAt: number;
  lastSeq: number;
  exitCode: number | null;
  error: string | null;
};
const app = document.querySelector<HTMLDivElement>('#app')!;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
let devices: Device[] = [],
  tasks: Task[] = [],
  selectedDevice = '',
  selectedTask = '',
  currentSession = crypto.randomUUID();
let outputCursor = 0,
  outputText = '',
  loggedIn = false,
  loading = false,
  detailLoading = false,
  socket: WebSocket | undefined,
  poll: ReturnType<typeof setInterval> | undefined,
  view = 'chat';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  machine:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5M7 8l3 2-3 2m6 0h4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-5v6l4 2"/>',
  link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-8-4h12"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = (name: keyof typeof icons) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const mark =
  '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m7 9 9 16 9-16M12 8l4 7 4-7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
function toast(message: string) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}
async function api(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const res = await fetch('/api' + path, {
    signal: AbortSignal.timeout(30000),
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') login();
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}
function ago(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
function badge(status: string) {
  return `<span class="badge ${esc(status)}"><i></i>${esc(status)}</span>`;
}
function login() {
  loggedIn = false;
  chat?.dispose();
  chat = undefined;
  socket?.close();
  if (poll) clearInterval(poll);
  app.innerHTML = `<main class="login-page"><div class="login-story"><a class="brand" href="/">${mark}veronica<span class="word-dot">.</span></a><div class="login-copy"><span class="eyebrow">YOUR PERSONAL CONTROL ROOM</span><h1>Good work.<br>From anywhere.</h1><p>Bring your development machines together.<br>Pick a machine, send a task, stay in the flow.</p><div class="orbit-art"><div class="orbit-center">${mark}</div><span class="orbit-node n1">${icon('machine')}</span><span class="orbit-node n2">${icon('machine')}</span><span class="orbit-node n3">${icon('machine')}</span></div></div><span class="story-footer">YOUR MACHINES. YOUR INFRASTRUCTURE.</span></div><div class="login-form-wrap"><form id="login-form"><span class="eyebrow">WELCOME HOME</span><h2>Open your workspace</h2><p>Sign in with the administrator key you set when deploying Veronica.</p><label for="key">Administrator key</label><input id="key" type="password" autocomplete="current-password" placeholder="Enter your private key" required minlength="32"/><p id="login-error" class="form-error" role="alert"></p><button class="primary" type="submit">Enter workspace ${icon('arrow')}</button><div class="privacy-note">${icon('link')} A private connection to your own server.</div></form><div class="login-bottom">VERONICA <span>PERSONAL EDITION · 0.1</span></div></div></main>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $<HTMLButtonElement>('#login-form button');
    button.disabled = true;
    try {
      await api('/login', { token: $<HTMLInputElement>('#key').value });
      await dashboard();
    } catch (error) {
      $('#login-error').textContent = (error as Error).message;
    } finally {
      button.disabled = false;
    }
  });
}
async function dashboard() {
  loggedIn = true;
  socket?.close();
  if (poll) clearInterval(poll);
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="/">${mark}veronica<span class="word-dot">.</span></a><div class="workspace-tag"><span class="avatar">P</span><div>Personal workspace<small>Just you. All your machines.</small></div></div><span class="nav-caption">WORKSPACE</span><nav><button class="nav-item" data-view="chat">${icon('arrow')}Chat</button><button class="nav-item active" data-view="machines">${icon('grid')}Machines<span id="nav-count">0</span></button><button class="nav-item" data-view="activity">${icon('history')}Activity</button><button class="nav-item" data-view="operators">${icon('link')}Operators</button></nav><div class="sidebar-note"><span class="mini-star">✳</span><strong>A little closer to your work.</strong><p>Your machines stay yours.<br>Veronica keeps you connected.</p></div><div class="sidebar-bottom"><span id="connection"><i></i> Connecting</span><button id="logout" class="icon-button" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div></aside><main class="main"><header class="topbar"><span><span class="muted">Workspace</span><b>/</b><span id="breadcrumb">Machines</span></span><span class="personal-pill">${icon('link')} Personal server</span></header><section class="page-head"><div><span class="eyebrow">MAKE YOURSELF AT HOME</span><h1 id="page-title">Your machines.<span>Within reach.</span></h1><p id="page-subtitle">A single place to move your work forward, wherever it lives.</p></div><button id="add-device" class="primary">${icon('plus')} Connect a machine</button></section><section id="chat-view"></section><section id="machines-view"><div class="section-title"><h2>Connected machines <span id="device-count">00</span></h2><span id="online-count" class="muted"></span></div><div id="devices" class="device-grid"></div><div class="work-grid"><section class="panel composer"><div class="panel-heading"><div class="section-icon">${icon('arrow')}</div><div><h2>Start something</h2><p>Choose where your next task runs.</p></div></div><form id="task-form"><div class="field-row"><div><label for="device-select">Machine</label><select id="device-select" required></select></div><div><label for="executor">Run with</label><select id="executor"><option value="shell">Shell command</option><option value="agent">Coding agent</option></select></div></div><label for="cwd">Working directory <span>relative to machine root</span></label><input id="cwd" value="." spellcheck="false"/><label for="task-input">Your task</label><textarea id="task-input" rows="4" placeholder="What would you like to work on?" maxlength="32000" required></textarea><div class="composer-bottom"><button id="new-session" class="text-button" type="button">New conversation</button><button id="run-task" class="primary" type="submit">Run task ${icon('arrow')}</button></div><p id="queue-note" class="small-note"></p></form></section><section class="panel recent-panel"><div class="section-title"><h2>Recent activity</h2><span class="live-label"><i></i>LIVE</span></div><div id="recent-tasks"></div></section></div></section><section id="activity-view" hidden><div class="panel activity-panel"><div class="section-title"><h2>Task history</h2><span class="muted">Latest 100 tasks</span></div><div id="all-tasks"></div></div></section><section id="operators-view" hidden><div class="panel operator-intro"><div class="section-icon">${icon('link')}</div><div><h2>More ways to stay in touch.</h2><p>Connect an ACP client, including wechat-acp, to one of your machines. Each operator gets its own revocable key.</p><button id="create-operator" class="primary">${icon('plus')} Create an operator</button></div></div><div id="operator-list"></div><p class="small-note">Text prompts are supported. Agent permissions are approved here in your dashboard.</p></section><section id="task-detail" class="terminal-panel" hidden><div class="terminal-top"><div><span class="terminal-dots"><i></i><i></i><i></i></span><span id="terminal-title">Task output</span></div><div id="terminal-actions"></div></div><div class="terminal-meta"><code id="terminal-command"></code><span id="terminal-status"></span></div><div id="permission-list"></div><pre id="terminal-output" tabindex="0" aria-label="Task output"></pre><div class="terminal-footer"><span id="terminal-info"></span><button id="copy-output" class="text-button">${icon('copy')} Copy output</button></div></section><footer class="page-footer"><span>BUILT FOR THE WAY YOU WORK.</span><span>Veronica <b>↗</b> <a href="https://github.com/bttb2020/veronica" target="_blank" rel="noreferrer">Source & documentation</a></span></footer></main></div>`;
  chat?.dispose();
  chat = new Conversations($('#chat-view'), api, toast, pairDialog);
  $('#logout').onclick = async () => {
    await api('/logout', {});
    login();
  };
  $('#add-device').onclick = pairDialog;
  $('#create-operator').onclick = operatorDialog;
  document
    .querySelectorAll<HTMLButtonElement>('[data-view]')
    .forEach(
      (button) => (button.onclick = () => changeView(button.dataset.view!)),
    );
  $<HTMLSelectElement>('#device-select').onchange = () => {
    selectedDevice = $<HTMLSelectElement>('#device-select').value;
    renderDevices();
    updateExecutor();
  };
  $('#new-session').onclick = () => {
    currentSession = crypto.randomUUID();
    toast(
      'New conversation started. Your next agent task will have a fresh context.',
    );
  };
  $('#copy-output').onclick = () => {
    void navigator.clipboard
      .writeText(outputText)
      .then(() => toast('Output copied.'))
      .catch(() => toast('Clipboard unavailable in this browser.'));
  };
  $('#task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $<HTMLButtonElement>('#run-task');
    button.disabled = true;
    try {
      const result = await api('/tasks', {
        id: crypto.randomUUID(),
        deviceId: selectedDevice,
        sessionId: currentSession,
        executor: $<HTMLSelectElement>('#executor').value,
        cwd: $<HTMLInputElement>('#cwd').value,
        input: $<HTMLTextAreaElement>('#task-input').value,
      });
      $<HTMLTextAreaElement>('#task-input').value = '';
      await refresh();
      await selectTask(result.task.id);
      toast(
        result.task.status === 'queued'
          ? 'Task queued. It will run when the machine is available.'
          : 'Task sent to your machine.',
      );
    } catch (error) {
      toast((error as Error).message);
    } finally {
      button.disabled = !devices.length;
    }
  });
  changeView(view);
  await refresh();
  connectEvents();
  poll = setInterval(() => {
    void refresh();
  }, 5000);
}
function connectEvents() {
  if (!loggedIn) return;
  socket = new WebSocket(
    location.origin.replace(/^http/, 'ws') + '/api/events',
  );
  socket.onopen = () => {
    if (loggedIn)
      $('#connection').innerHTML = '<i class="online-dot"></i> Connected';
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  socket.onmessage = () => {
    if (!debounce)
      debounce = setTimeout(() => {
        debounce = undefined;
        void refresh();
      }, 250);
  };
  socket.onclose = () => {
    if (!loggedIn) return;
    $('#connection').innerHTML = '<i></i> Reconnecting';
    setTimeout(() => {
      if (loggedIn) connectEvents();
    }, 3000);
  };
}
async function refresh() {
  if (!loggedIn || loading) return;
  loading = true;
  try {
    const [d, t] = await Promise.all([api('/devices'), api('/tasks')]);
    if (!loggedIn) return;
    devices = d.devices;
    tasks = t.tasks;
    if (!devices.some((d) => d.id === selectedDevice))
      selectedDevice = devices[0]?.id ?? '';
    renderDevices();
    renderTasks();
    if (view === 'chat') await chat?.refresh(devices);
    if (selectedTask) await refreshDetail();
  } catch (error) {
    if (loggedIn) toast((error as Error).message);
  } finally {
    loading = false;
  }
}
function renderDevices() {
  $('#nav-count').textContent = String(devices.length);
  $('#device-count').textContent = String(devices.length).padStart(2, '0');
  $('#online-count').textContent =
    `${devices.filter((d) => d.online).length} online`;
  $('#devices').innerHTML = devices.length
    ? devices
        .map(
          (d) =>
            `<article class="device-card ${d.id === selectedDevice ? 'selected' : ''}" data-device="${esc(d.id)}" tabindex="0" role="button" aria-pressed="${d.id === selectedDevice}" aria-label="Select ${esc(d.name)}"><div class="device-card-top"><span class="device-icon">${icon('machine')}</span>${badge(d.online ? 'online' : 'offline')}</div><h3>${esc(d.name)}</h3><p>${esc(d.platform || 'Waiting for first connection')}<span>·</span>${esc(d.hostname || 'New machine')}</p><code title="${esc(d.root)}">${esc(d.root || 'Start the client to finish connecting')}</code><div class="device-card-bottom"><span>${d.capabilities.map((c) => `<span class="capability">${esc(c === 'agent' ? 'ACP agent' : 'Shell')}</span>`).join('') || '<span class="muted">Not connected yet</span>'}</span><button class="revoke-device" data-revoke="${esc(d.id)}" aria-label="Revoke ${esc(d.name)}" title="Revoke device">${icon('close')}</button></div></article>`,
        )
        .join('')
    : `<div class="empty-machines"><div class="empty-icon">${icon('machine')}</div><div><h3>Give your workspace its first machine.</h3><p>Connect your laptop, workstation, or a development server.<br>Your next task is only a connection away.</p></div><button id="empty-connect" class="secondary">Connect a machine ${icon('arrow')}</button></div>`;
  document.querySelectorAll<HTMLElement>('[data-device]').forEach((el) => {
    const select = () => {
      selectedDevice = el.dataset.device!;
      renderDevices();
      updateExecutor();
    };
    el.onclick = select;
    el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    };
  });
  document.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach(
    (el) =>
      (el.onclick = (e) => {
        e.stopPropagation();
        revokeDialog(el.dataset.revoke!);
      }),
  );
  if ($('#empty-connect')) $('#empty-connect').onclick = pairDialog;
  const select = $<HTMLSelectElement>('#device-select');
  const markup =
    devices
      .map(
        (d) =>
          `<option value="${esc(d.id)}">${esc(d.name)}${d.online ? '' : ' · offline'}</option>`,
      )
      .join('') || '<option value="">Connect a machine first</option>';
  if (select.innerHTML !== markup) select.innerHTML = markup;
  select.value = selectedDevice;
  updateExecutor();
}
function updateExecutor() {
  const device = devices.find((d) => d.id === selectedDevice),
    select = $<HTMLSelectElement>('#executor');
  for (const option of select.options)
    option.disabled = !device?.capabilities.includes(option.value);
  if (select.selectedOptions[0]?.disabled)
    select.value = device?.capabilities[0] ?? 'shell';
  $<HTMLButtonElement>('#run-task').disabled = !device?.capabilities.length;
  $('#queue-note').textContent = !device
    ? 'Connect a machine to run your first task.'
    : !device.capabilities.length
      ? 'Start the client to discover its available executors.'
      : !device.online
        ? 'This machine is offline. Tasks will wait in its queue.'
        : 'Tasks on the same machine run one at a time.';
}
function taskMarkup(list: Task[]) {
  return list.length
    ? list
        .map(
          (t) =>
            `<button class="task-row ${t.id === selectedTask ? 'selected' : ''}" data-task="${esc(t.id)}"><span class="task-indicator ${esc(t.status)}">${terminal.has(t.status) ? icon(t.status === 'completed' ? 'check' : 'stop') : icon('arrow')}</span><span class="task-summary"><strong>${esc(t.input)}</strong><small>${esc(devices.find((d) => d.id === t.deviceId)?.name ?? 'Revoked machine')}<span>·</span>${esc(t.executor)}<span>·</span>${ago(t.createdAt)}</small></span>${badge(t.status)}</button>`,
        )
        .join('')
    : `<div class="empty-activity">${icon('history')}<h3>A fresh start.</h3><p>Your tasks and their progress will appear here.</p></div>`;
}
function renderTasks() {
  $('#recent-tasks').innerHTML = taskMarkup(tasks.slice(0, 4));
  $('#all-tasks').innerHTML = taskMarkup(tasks);
  document.querySelectorAll<HTMLButtonElement>('[data-task]').forEach(
    (el) =>
      (el.onclick = () => {
        void selectTask(el.dataset.task!);
      }),
  );
}
async function selectTask(id: string) {
  selectedTask = id;
  outputCursor = 0;
  outputText = '';
  $('#terminal-output').textContent = '';
  $('#task-detail').hidden = false;
  renderTasks();
  await refreshDetail();
  $('#task-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function refreshDetail() {
  if (detailLoading || !selectedTask) return;
  detailLoading = true;
  const id = selectedTask;
  try {
    let more = true,
      task: Task | undefined;
    while (more) {
      const result = await api(
        `/tasks/${encodeURIComponent(id)}?after=${outputCursor}`,
      );
      if (selectedTask !== id || !loggedIn) return;
      task = result.task;
      for (const event of result.events) {
        outputCursor = event.seq;
        if (event.kind === 'output') outputText += event.data.text;
      }
      more = result.events.length === 200;
      $('#permission-list').innerHTML = result.permissions
        .map(
          (p: any) =>
            `<div class="permission"><div><strong>Permission requested</strong><p>${esc(p.data.toolCall?.title)}</p></div><div>${p.data.options.map((o: any) => `<button class="secondary" data-permission="${esc(p.requestId)}" data-option="${esc(o.optionId)}">${esc(o.name)}</button>`).join('')}<button class="secondary" data-permission="${esc(p.requestId)}">Dismiss</button></div></div>`,
        )
        .join('');
    }
    if (!task) return;
    const output = $('#terminal-output');
    const nearBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight < 80;
    output.textContent =
      outputText ||
      (task.error
        ? task.error
        : terminal.has(task.status)
          ? 'Task finished without output.'
          : 'Waiting for output…');
    if (nearBottom) output.scrollTop = output.scrollHeight;
    $('#terminal-title').textContent =
      devices.find((d) => d.id === task!.deviceId)?.name ?? 'Task output';
    $('#terminal-command').textContent = task.input;
    $('#terminal-status').innerHTML = badge(task.status);
    $('#terminal-info').textContent =
      `${task.executor} · ${task.cwd}${task.exitCode !== null ? ` · exit ${task.exitCode}` : ''}${task.error ? ` · ${task.error}` : ''}`;
    $('#terminal-actions').innerHTML = terminal.has(task.status)
      ? '<button id="delete-task" class="terminal-button">Delete from history</button>'
      : `<button id="cancel-task" class="terminal-button">${icon('stop')} ${task.status === 'cancelling' ? 'Cancellation requested' : 'Cancel task'}</button>`;
    if ($('#cancel-task'))
      $('#cancel-task').onclick = () => {
        void api(`/tasks/${id}/cancel`, {})
          .then(() => refresh())
          .catch((e) => toast(e.message));
      };
    if ($('#delete-task'))
      $('#delete-task').onclick = () => {
        void api(`/tasks/${id}`, undefined, 'DELETE')
          .then(() => {
            selectedTask = '';
            $('#task-detail').hidden = true;
            void refresh();
          })
          .catch((e) => toast(e.message));
      };
    document.querySelectorAll<HTMLButtonElement>('[data-permission]').forEach(
      (el) =>
        (el.onclick = () => {
          el.disabled = true;
          void api(`/tasks/${id}/permissions`, {
            requestId: el.dataset.permission,
            optionId: el.dataset.option ?? null,
          })
            .then(() => refresh())
            .catch((e) => toast(e.message));
        }),
    );
  } catch (error) {
    toast((error as Error).message);
  } finally {
    detailLoading = false;
  }
}
function changeView(next: string) {
  view = next;
  document
    .querySelector('.workspace')
    ?.classList.toggle('chat-mode', view === 'chat');
  if (view === 'chat') void chat?.refresh(devices);
  for (const name of ['chat', 'machines', 'activity', 'operators'])
    $(`#${name}-view`).hidden = name !== view;
  document
    .querySelectorAll<HTMLElement>('[data-view]')
    .forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  $('#breadcrumb').textContent = view[0].toUpperCase() + view.slice(1);
  $('#page-title').innerHTML =
    view === 'machines'
      ? 'Your machines.<span>Within reach.</span>'
      : view === 'activity'
        ? 'Work in motion.<span>All in view.</span>'
        : 'Your workspace.<span>More ways in.</span>';
  $('#page-subtitle').textContent =
    view === 'machines'
      ? 'A single place to move your work forward, wherever it lives.'
      : view === 'activity'
        ? 'Follow every task, from the first command to the last line.'
        : 'Bring your favorite tools to the machines you already know.';
  $('#add-device').hidden = view !== 'machines';
  if (view === 'operators') void renderOperators();
}
function dialog(title: string, content: string): HTMLDialogElement {
  document.querySelector('dialog')?.remove();
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dialog-heading"><h2>${esc(title)}</h2><button class="icon-button close-dialog" aria-label="Close dialog">${icon('close')}</button></div>${content}`;
  document.body.append(d);
  d.querySelector<HTMLElement>('.close-dialog')!.onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.showModal();
  return d;
}
function pairDialog() {
  const d = dialog(
    'Connect a machine',
    `<p class="dialog-description">Give your machine a name. Then run the pairing command on that machine.</p><form id="pair-form"><label for="machine-name">Machine name</label><input id="machine-name" placeholder="e.g. Studio Mac, Build server" maxlength="80" required/><label for="pair-agent">Coding agent</label><select id="pair-agent"><option value="codex">Codex</option><option value="claude">Claude</option><option value="shell">Shell only</option></select><button class="primary" type="submit">Create pairing code ${icon('arrow')}</button></form>`,
  );
  d.querySelector('form')!.onsubmit = async (e) => {
    e.preventDefault();
    const button = d.querySelector<HTMLButtonElement>('button[type=submit]')!;
    button.disabled = true;
    try {
      const pairing = await api('/pairings', {
        name: $<HTMLInputElement>('#machine-name').value,
      });
      const agent = $<HTMLSelectElement>('#pair-agent').value;
      const agentFlag = agent === 'shell' ? '' : ` --agent ${agent}`;
      const command = `veronica-client pair --server ${location.origin} --code ${pairing.code} --root . --allow-shell${agentFlag}`;
      d.innerHTML = `<div class="dialog-heading"><h2>Make the connection.</h2><button class="icon-button close-dialog" aria-label="Close">${icon('close')}</button></div><p class="dialog-description">Run these commands on your development machine with Node.js 22 or newer. Choose your project directory first.</p><div class="install-step"><span>01</span><div><strong>Install the client</strong><pre>npm install -g https://github.com/bttb2020/veronica-client/releases/download/v0.2.0/bttb2020-veronica-client-0.2.0.tgz</pre></div></div><div class="install-step"><span>02</span><div><strong>Pair this directory</strong><pre id="pair-command"></pre></div></div><div class="install-step"><span>03</span><div><strong>Keep your machine connected</strong><pre>veronica-client service install</pre><p class="small-note">On Linux or macOS, this installs a service that starts at login. For a foreground session or other operating systems, run <code>veronica-client start</code>.</p></div></div><p class="small-note">This one-time code expires in 10 minutes. Complete the chosen agent’s local authentication on this machine first. The adapter uses your local credentials. Keep the machine awake and connected; closing this web page does not stop its work.</p><button id="copy-pair" class="primary">${icon('copy')} Copy pairing command</button>`;
      $('#pair-command').textContent = command;
      $('#copy-pair').onclick = () => {
        void navigator.clipboard
          .writeText(command)
          .then(() => toast('Pairing command copied.'))
          .catch(() => toast('Select and copy the command above.'));
      };
      d.querySelector<HTMLElement>('.close-dialog')!.onclick = () => d.close();
    } catch (error) {
      toast((error as Error).message);
      button.disabled = false;
    }
  };
}
function revokeDialog(id: string) {
  const d = dialog(
    'Disconnect this machine?',
    `<p class="dialog-description">This revokes the machine credential and its operator keys. Queued tasks stop; active work is cancelled if the machine is connected. Offline work may continue locally until it reconnects.</p><button id="confirm-revoke" class="danger">Revoke machine</button>`,
  );
  $('#confirm-revoke').onclick = () => {
    void api(`/devices/${id}`, undefined, 'DELETE')
      .then(() => {
        d.close();
        void refresh();
      })
      .catch((e) => toast(e.message));
  };
}
async function renderOperators() {
  try {
    const { operators } = await api('/operators');
    if (!loggedIn) return;
    $('#operator-list').innerHTML = operators.length
      ? operators
          .map(
            (o: any) =>
              `<div class="operator-row"><span class="section-icon">${icon('link')}</span><div><strong>${esc(o.name)}</strong><p>${esc(devices.find((d) => d.id === o.deviceId)?.name ?? 'Revoked machine')}</p></div><button class="text-button" data-operator="${esc(o.id)}">Revoke key</button></div>`,
          )
          .join('')
      : '<div class="operator-empty">No operators yet. Create a key to connect another tool.</div>';
    document.querySelectorAll<HTMLButtonElement>('[data-operator]').forEach(
      (el) =>
        (el.onclick = () => {
          void api(`/operators/${el.dataset.operator}`, undefined, 'DELETE')
            .then(() => renderOperators())
            .catch((e) => toast(e.message));
        }),
    );
  } catch (error) {
    toast((error as Error).message);
  }
}
function operatorDialog() {
  if (!devices.length) {
    toast('Connect a machine before creating an operator.');
    return;
  }
  const d = dialog(
    'Create an operator',
    `<p class="dialog-description">The key can submit tasks and read results on the selected machine. Save it securely; it is shown only once.</p><form id="operator-form"><label for="operator-name">Operator name</label><input id="operator-name" placeholder="e.g. WeChat" maxlength="80" required/><label for="operator-device">Machine</label><select id="operator-device">${devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select><button class="primary" type="submit">Create key ${icon('arrow')}</button></form>`,
  );
  d.querySelector('form')!.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const result = await api('/operators', {
        name: $<HTMLInputElement>('#operator-name').value,
        deviceId: $<HTMLSelectElement>('#operator-device').value,
      });
      d.innerHTML = `<div class="dialog-heading"><h2>Your operator is ready.</h2><button class="icon-button close-dialog" aria-label="Close">${icon('close')}</button></div><label>Private operator key</label><pre id="operator-key"></pre><button id="copy-key" class="secondary">${icon('copy')} Copy key</button><p class="dialog-description">Save the key in a local file with restricted permissions, then configure the operator:</p><pre id="operator-command"></pre><p class="dialog-description">Start the optional WeChat adapter:</p><pre>npx -y wechat-acp --agent "veronica-client acp"</pre><p class="small-note">The target machine needs an ACP agent configured. Permission requests remain in this dashboard. WeChat login runs on the operator machine.</p>`;
      $('#operator-key').textContent = result.token;
      $('#operator-command').textContent =
        `veronica-client operator --server ${location.origin} --device ${result.deviceId} --token-stdin < /path/to/private-key.txt`;
      $('#copy-key').onclick = () => {
        void navigator.clipboard
          .writeText(result.token)
          .then(() => toast('Operator key copied.'))
          .catch(() => toast('Select and copy the key above.'));
      };
      d.querySelector<HTMLElement>('.close-dialog')!.onclick = () => d.close();
      void renderOperators();
    } catch (error) {
      toast((error as Error).message);
    }
  };
}
async function boot() {
  try {
    await api('/me');
    await dashboard();
  } catch {
    login();
  }
}
void boot();
