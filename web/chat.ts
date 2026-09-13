import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './chat.css';
type Row = Record<string, any>;
type Api = (path: string, body?: unknown, method?: string) => Promise<any>;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const md = (s: string) =>
  DOMPurify.sanitize(marked.parse(s, { async: false }) as string, {
    FORBID_TAGS: ['img', 'form', 'input', 'button'],
  });
const time = (n: number) =>
  new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const remember = (key: string, value?: string) => {
  try {
    if (value !== undefined) localStorage.setItem('veronica.' + key, value);
    return localStorage.getItem('veronica.' + key) ?? '';
  } catch {
    return '';
  }
};
export class Conversations {
  sessions: Row[] = [];
  devices: Row[] = [];
  turns: Row[] = [];
  files: Row[] = [];
  selected = '';
  conversation: Row | undefined;
  busy = false;
  sending = false;
  hasMore = false;
  disposed = false;
  detailBusy = false;
  cache = new Map<string, { seq: number; events: Row[]; permissions: Row[] }>();
  uploadFiles: File[] = [];
  pendingSubmission: Row | undefined;
  constructor(
    readonly root: HTMLElement,
    readonly api: Api,
    readonly toast: (s: string) => void,
    readonly pair: () => void,
  ) {
    root.innerHTML = `<div class="chat-layout"><aside class="conversations"><div class="conversation-heading"><span class="eyebrow">YOUR CONVERSATIONS</span><button id="chat-new" class="primary">＋ New chat</button></div><input id="chat-search" type="search" placeholder="Search conversations" aria-label="Search conversations"/><label class="archive-filter"><input id="chat-archived" type="checkbox"/> Show archived</label><div id="conversation-list"></div><button id="chat-connect" class="text-button">＋ Connect a machine</button></aside><section class="chat-room"><header class="chat-header"><div><span class="eyebrow">A LITTLE CLOSER TO YOUR WORK</span><h2 id="chat-title">What shall we work on?</h2><p id="chat-context"></p></div><div class="chat-actions"><button id="chat-rename" class="icon-button" title="Rename conversation" aria-label="Rename conversation">✎</button><button id="chat-delete" class="icon-button" title="Delete conversation" aria-label="Delete conversation">×</button><button id="chat-export" class="icon-button" title="Download conversation" aria-label="Download conversation">↓</button><button id="chat-archive" class="icon-button" title="Archive conversation" aria-label="Archive conversation">▣</button></div></header><div id="chat-transcript" class="chat-transcript" role="log" aria-label="Conversation"><div class="chat-welcome"><span class="welcome-symbol">✳</span><h1>Good work starts<br>with a conversation.</h1><p>Choose your machine and project. Your agent takes it from here.</p><div class="chat-starters"><button data-starter="Explore this project and explain its architecture.">Explore a project ↗</button><button data-starter="Review the current changes and look for bugs.">Review my changes ↗</button><button data-starter="Help me plan and implement the next feature.">Build something ↗</button></div></div></div><form id="chat-form" class="chat-composer"><div class="chat-configuration"><label>Machine<select id="chat-machine" aria-label="Chat machine"></select></label><label>Run with<select id="chat-executor" aria-label="Chat executor"><option value="agent">Coding agent</option><option value="shell">Shell command</option></select></label><label class="project-field">Project<input id="chat-cwd" aria-label="Project directory" value="." list="chat-projects" spellcheck="false"/><datalist id="chat-projects"></datalist></label></div><p id="chat-offline" class="connection-notice" hidden></p><div id="chat-attachments" class="chat-attachments"></div><textarea id="chat-prompt" aria-label="Message" placeholder="Tell your agent what you’d like to do…" rows="3" maxlength="32000"></textarea><div class="chat-composer-actions"><div><label class="attach-button" title="Attach images or files">＋ Attach<input id="chat-file" type="file" multiple hidden/></label><span class="keyboard-hint">Enter to send · Shift + Enter for a new line</span></div><div><button id="chat-stop" type="button" class="secondary" hidden>■ Stop</button><button id="chat-send" type="submit" class="primary">Send ↑</button></div></div><p id="chat-hint" class="small-note">Messages and results stay here when you close the page. /new · /stop · /cd</p></form></section></div>`;
    this.selected =
      new URLSearchParams(location.hash.slice(1)).get('chat') ||
      remember('last-chat');
    this.el('chat-new').onclick = () => this.newChat();
    this.el('chat-connect').onclick = pair;
    this.el<HTMLInputElement>('chat-search').oninput = () => this.renderList();
    this.el<HTMLInputElement>('chat-archived').onchange = () =>
      void this.refresh(this.devices);
    this.el<HTMLSelectElement>('chat-machine').onchange = () =>
      this.configure();
    this.el<HTMLSelectElement>('chat-executor').onchange = () =>
      this.configure();
    this.el('chat-rename').onclick = () => void this.rename();
    this.el('chat-delete').onclick = () => void this.delete();
    this.el('chat-archive').onclick = () => void this.archive();
    this.el('chat-export').onclick = () => void this.export();
    this.el('chat-stop').onclick = () => void this.stop();
    this.el<HTMLFormElement>('chat-form').onsubmit = (e) => {
      e.preventDefault();
      void this.send();
    };
    const prompt = this.el<HTMLTextAreaElement>('chat-prompt');
    prompt.oninput = () =>
      remember('draft.' + (this.selected || 'new'), prompt.value);
    prompt.onkeydown = (e) => {
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.isComposing &&
        innerWidth > 640
      ) {
        e.preventDefault();
        void this.send();
      }
    };
    this.el<HTMLInputElement>('chat-file').onchange = (e) => {
      this.attach([...((e.target as HTMLInputElement).files ?? [])]);
      (e.target as HTMLInputElement).value = '';
    };
    prompt.onpaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        this.attach(files);
      }
    };
    this.el('chat-transcript').ondragover = (e) => e.preventDefault();
    this.el('chat-transcript').ondrop = (e) => {
      e.preventDefault();
      this.attach([...(e.dataTransfer?.files ?? [])]);
    };
    root.querySelectorAll<HTMLElement>('[data-starter]').forEach(
      (b) =>
        (b.onclick = () => {
          prompt.value = b.dataset.starter!;
          prompt.focus();
        }),
    );
    prompt.value = remember('draft.' + (this.selected || 'new'));
    try {
      this.el('chat-projects').innerHTML = JSON.parse(
        remember('projects') || '[]',
      )
        .map((x: string) => `<option value="${esc(x)}">`)
        .join('');
    } catch {}
  }
  el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>('#' + id)!;
  }
  async refresh(devices: Row[]) {
    this.devices = devices;
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      const archived = this.el<HTMLInputElement>('chat-archived').checked;
      const data = await this.api(
        '/sessions' + (archived ? '?archived=true' : ''),
      );
      if (this.disposed) return;
      this.sessions = data.sessions;
      this.renderList();
      this.configure();
      if (this.selected) await this.load();
    } catch (e) {
      if (!this.disposed) this.toast((e as Error).message);
    } finally {
      this.busy = false;
    }
  }
  renderList() {
    const q = this.el<HTMLInputElement>('chat-search').value.toLowerCase();
    const list = this.sessions.filter((s) =>
      (s.title + ' ' + s.cwd).toLowerCase().includes(q),
    );
    this.el('conversation-list').innerHTML = list.length
      ? list
          .map(
            (s) =>
              `<button class="conversation-item ${s.id === this.selected ? 'selected' : ''}" data-conversation="${esc(s.id)}"><span>${esc(s.title)}</span><small>${s.pending ? '◌ ' + s.pending + ' in progress · ' : ''}${esc(this.devices.find((d) => d.id === s.deviceId)?.name || 'Machine')} · ${esc(s.cwd)}</small></button>`,
          )
          .join('')
      : '<p class="empty-conversations">Your conversations will be saved here.</p>';
    this.root
      .querySelectorAll<HTMLElement>('[data-conversation]')
      .forEach(
        (b) => (b.onclick = () => void this.select(b.dataset.conversation!)),
      );
  }
  configure() {
    const machine = this.el<HTMLSelectElement>('chat-machine'),
      executor = this.el<HTMLSelectElement>('chat-executor');
    const selected =
      this.conversation?.deviceId || machine.value || remember('machine');
    const html =
      this.devices
        .map(
          (d) =>
            `<option value="${esc(d.id)}">${esc(d.name)}${d.online ? '' : ' · offline'}</option>`,
        )
        .join('') || '<option value="">Connect a machine</option>';
    if (machine.innerHTML !== html) machine.innerHTML = html;
    if (this.devices.some((d) => d.id === selected)) machine.value = selected;
    if (this.conversation) {
      executor.value = this.conversation.executor;
      this.el<HTMLInputElement>('chat-cwd').value = this.conversation.cwd;
    }
    const device = this.devices.find((d) => d.id === machine.value);
    for (const option of executor.options)
      option.disabled = !device?.capabilities.includes(option.value);
    if (!this.conversation && executor.selectedOptions[0]?.disabled)
      executor.value = device?.capabilities.includes('agent')
        ? 'agent'
        : 'shell';
    machine.disabled =
      executor.disabled =
      this.el<HTMLInputElement>('chat-cwd').disabled =
        !!this.conversation;
    const active = this.turns.filter((t) => !terminal.has(t.status));
    this.el<HTMLButtonElement>('chat-stop').hidden = !active.length;
    this.el<HTMLButtonElement>('chat-send').disabled =
      this.sending ||
      (!!this.selected && !this.conversation) ||
      !device ||
      !device.capabilities.includes(executor.value) ||
      !!this.conversation?.archived;
    this.el('chat-send').textContent = this.sending
      ? 'Sending…'
      : active.length
        ? 'Queue message ↑'
        : 'Send ↑';
    const notice = this.el('chat-offline');
    notice.hidden = !!device?.online;
    notice.textContent = device
      ? `${device.name} is offline. Messages will wait until veronica-client is running on that machine. A browser cannot start an offline computer.`
      : 'Connect a development machine to start your first conversation.';
    if (device?.online && !device.capabilities.includes('agent')) {
      notice.hidden = false;
      notice.textContent =
        'This machine has Shell only. To enable chat, run veronica-client configure --agent codex (or claude), then restart its service.';
    }
    this.el('chat-title').textContent =
      this.conversation?.title || 'What shall we work on?';
    this.el('chat-context').textContent = device
      ? `${device.online ? '● Online' : '○ Offline'} · ${device.name} · ${this.conversation?.cwd || this.el<HTMLInputElement>('chat-cwd').value} · ${executor.value === 'agent' ? 'Coding agent' : 'Shell'}`
      : '';
    for (const id of [
      'chat-rename',
      'chat-archive',
      'chat-export',
      'chat-delete',
    ])
      this.el<HTMLButtonElement>(id).disabled = !this.conversation;
    this.el('chat-archive').title = this.conversation?.archived
      ? 'Restore conversation'
      : 'Archive conversation';
  }
  async select(id: string) {
    if (this.sending) {
      this.toast('Wait for this message to finish sending.');
      return;
    }
    remember(
      'draft.' + (this.selected || 'new'),
      this.el<HTMLTextAreaElement>('chat-prompt').value,
    );
    this.selected = id;
    this.conversation = undefined;
    this.turns = [];
    this.files = [];
    this.uploadFiles = [];
    this.pendingSubmission = undefined;
    remember('last-chat', id);
    history.replaceState(null, '', '#chat=' + encodeURIComponent(id));
    this.el<HTMLTextAreaElement>('chat-prompt').value = remember('draft.' + id);
    this.renderAttachments();
    try {
      await this.load();
      this.renderList();
    } catch (e) {
      this.toast((e as Error).message);
    }
  }
  newChat(cwd?: string) {
    if (this.sending) {
      this.toast('Wait for this message to finish sending.');
      return;
    }
    remember(
      'draft.' + (this.selected || 'new'),
      this.el<HTMLTextAreaElement>('chat-prompt').value,
    );
    this.selected = '';
    this.conversation = undefined;
    this.turns = [];
    this.files = [];
    this.uploadFiles = [];
    this.pendingSubmission = undefined;
    remember('last-chat', '');
    history.replaceState(null, '', location.pathname);
    this.el<HTMLTextAreaElement>('chat-prompt').value = remember('draft.new');
    this.el('chat-transcript').innerHTML =
      '<div class="chat-welcome"><span class="welcome-symbol">✳</span><h1>A fresh conversation.</h1><p>Choose a machine and project, then tell your agent what to do.</p></div>';
    this.configure();
    if (cwd) this.el<HTMLInputElement>('chat-cwd').value = cwd;
    this.renderList();
    this.renderAttachments();
    this.el('chat-prompt').focus();
  }
  async ensureSession() {
    if (this.selected && this.conversation) return this.conversation;
    const deviceId = this.el<HTMLSelectElement>('chat-machine').value,
      executor = this.el<HTMLSelectElement>('chat-executor').value,
      cwd = this.el<HTMLInputElement>('chat-cwd').value || '.';
    const result = await this.api('/sessions', { deviceId, executor, cwd });
    this.conversation = result.session;
    this.selected = result.session.id;
    remember('machine', deviceId);
    remember('last-chat', this.selected);
    remember(
      'draft.' + this.selected,
      this.el<HTMLTextAreaElement>('chat-prompt').value,
    );
    remember('draft.new', '');
    history.replaceState(
      null,
      '',
      '#chat=' + encodeURIComponent(this.selected),
    );
    let projects: string[] = [];
    try {
      projects = JSON.parse(remember('projects') || '[]');
    } catch {}
    remember(
      'projects',
      JSON.stringify([...new Set([cwd, ...projects])].slice(0, 20)),
    );
    return result.session;
  }
  async load(older = false) {
    const id = this.selected;
    if (!id || this.detailBusy) return;
    this.detailBusy = true;
    try {
      const before =
        older && this.turns.length ? '?before=' + this.turns[0].cursor : '';
      const data = await this.api(
        '/sessions/' + encodeURIComponent(id) + before,
      );
      if (this.disposed || id !== this.selected) return;
      this.conversation = data.session;
      this.files = data.attachments;
      if (older) this.turns = [...data.tasks, ...this.turns];
      else {
        const fresh = new Map(data.tasks.map((t: Row) => [t.id, t]));
        this.turns = [
          ...this.turns.filter((t) => !fresh.has(t.id)),
          ...data.tasks,
        ].sort((a, b) => a.cursor - b.cursor);
      }
      this.hasMore = older
        ? data.hasMore
        : this.turns.length > data.tasks.length
          ? this.hasMore
          : data.hasMore;
      // Fetch only changed turns; paginated replay also recovers output after refresh.
      await Promise.all(
        this.turns.map(async (t) => {
          let item = this.cache.get(t.id);
          if (item && item.seq === t.lastSeq && terminal.has(t.status)) return;
          if (!item) item = { seq: 0, events: [], permissions: [] };
          for (let page = 0; page < 100; page++) {
            const detail = await this.api(
              '/tasks/' + encodeURIComponent(t.id) + '?after=' + item.seq,
            );
            item.events.push(...detail.events);
            item.permissions = detail.permissions;
            item.seq = detail.events.at(-1)?.seq ?? item.seq;
            Object.assign(t, detail.task);
            this.cache.set(t.id, item);
            if (item.seq >= detail.task.lastSeq || !detail.events.length) break;
          }
        }),
      );
      if (this.disposed || id !== this.selected) return;
      this.configure();
      this.renderTranscript();
    } finally {
      this.detailBusy = false;
    }
  }
  renderTranscript() {
    const box = this.el('chat-transcript'),
      bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    const opened = new Set(
      [...box.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
        (d) => d.dataset.key,
      ),
    );
    box.innerHTML =
      (this.hasMore
        ? '<button id="chat-older" class="text-button">Load earlier messages</button>'
        : '') +
      (this.turns.length
        ? this.turns
            .map((t) => {
              const item = this.cache.get(t.id),
                events = item?.events ?? [];
              const answer = events
                .filter(
                  (e) => e.kind === 'output' && e.data.stream !== 'stderr',
                )
                .map((e) => e.data.text)
                .join('');
              const diagnostics = events
                .filter(
                  (e) => e.kind === 'output' && e.data.stream === 'stderr',
                )
                .map((e) => e.data.text)
                .join('');
              const activity = events
                .filter((e) => e.kind === 'activity')
                .map((e) => e.data);
              const fileIds = JSON.parse(t.attachmentIds || '[]');
              return `<article class="chat-turn" data-turn="${esc(t.id)}"><div class="message user-message"><div class="message-label">YOU <time>${time(t.createdAt)}</time></div><div class="user-text">${esc(t.input)}</div>${this.files
                .filter((f) => fileIds.includes(f.id))
                .map(
                  (f) =>
                    `<a class="file-chip" href="/api/attachments/${esc(f.id)}" download>${esc(f.name)} ↓</a>`,
                )
                .join(
                  '',
                )}</div><div class="message agent-message"><div class="message-label"><span class="agent-avatar">V</span> ${t.executor === 'shell' ? 'TERMINAL' : 'VERONICA'}<span class="turn-status ${esc(t.status)}">${esc(t.status)}</span></div>${activity.length ? `<details class="tool-activity" data-key="${esc(t.id)}" ${opened.has(t.id) ? 'open' : ''}><summary>${activity.length} progress updates</summary>${activity.map((a) => `<div class="tool-entry"><strong>${esc(a.title || a.kind || 'Progress')}</strong><small>${esc(a.status || '')}</small>${a.text ? `<pre>${esc(a.text)}</pre>` : ''}</div>`).join('')}</details>` : ''}<div class="message-body ${t.executor === 'shell' ? 'shell-result' : 'markdown'}">${answer ? (t.executor === 'shell' ? `<pre>${esc(answer)}</pre>` : md(answer)) : terminal.has(t.status) ? '<span class="muted">No text output.</span>' : `<span class="working-indicator">${t.status === 'queued' ? 'Waiting for its turn…' : t.status === 'cancelling' ? 'Stopping…' : 'Working…'}</span>`}</div>${diagnostics ? `<details><summary>Diagnostics</summary><pre>${esc(diagnostics)}</pre></details>` : ''}${t.error ? `<div class="turn-error">${esc(t.error)}</div>` : ''}${(item?.permissions ?? []).map((p) => `<div class="chat-permission"><strong>Permission needed</strong><p>${esc(p.data.toolCall?.title || 'Agent requests permission')}</p>${p.data.options.map((o: Row) => `<button class="secondary" data-permission="${esc(p.requestId)}" data-task="${esc(t.id)}" data-option="${esc(o.optionId)}">${esc(o.name)}</button>`).join('')}<button class="text-button" data-permission="${esc(p.requestId)}" data-task="${esc(t.id)}">Deny</button></div>`).join('')}<div class="message-footer"><button class="text-button" data-copy="${esc(t.id)}">Copy</button>${!terminal.has(t.status) ? `<button class="text-button" data-cancel="${esc(t.id)}">${t.status === 'queued' ? 'Remove from queue' : 'Stop'}</button>` : ''}${terminal.has(t.status) && t.status !== 'completed' ? `<button class="text-button" data-edit="${esc(t.id)}">Edit & resend</button>` : ''}</div></div></article>`;
            })
            .join('')
        : '<div class="chat-welcome"><span class="welcome-symbol">✳</span><h1>Your project, within reach.</h1><p>Send the first message to begin.</p></div>');
    this.root.querySelectorAll<HTMLElement>('[data-permission]').forEach(
      (b) =>
        (b.onclick = () => {
          void this.api('/tasks/' + b.dataset.task + '/permissions', {
            requestId: b.dataset.permission,
            optionId: b.dataset.option ?? null,
          })
            .then(() => this.load())
            .catch((e) => this.toast(e.message));
        }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-copy]').forEach(
      (b) =>
        (b.onclick = () => {
          const output =
            this.cache
              .get(b.dataset.copy!)
              ?.events.filter((e) => e.kind === 'output')
              .map((e) => e.data.text)
              .join('') || '';
          void navigator.clipboard
            .writeText(output)
            .then(() => this.toast('Copied.'))
            .catch(() => this.toast('Clipboard is unavailable.'));
        }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-cancel]').forEach(
      (b) =>
        (b.onclick = () => {
          void this.api('/tasks/' + b.dataset.cancel + '/cancel', {})
            .then(() => this.load())
            .catch((e) => this.toast(e.message));
        }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-edit]').forEach(
      (b) =>
        (b.onclick = () => {
          this.el<HTMLTextAreaElement>('chat-prompt').value =
            this.turns.find((t) => t.id === b.dataset.edit)?.input || '';
          this.el('chat-prompt').focus();
        }),
    );
    if (this.el('chat-older'))
      this.el('chat-older').onclick = () =>
        void this.load(true).catch((e) => this.toast(e.message));
    if (bottom) box.scrollTop = box.scrollHeight;
  }
  attach(files: File[]) {
    if (this.sending) return;
    if (files.some((f) => !f.size || f.size > 2 * 1024 * 1024)) {
      this.toast('Each attachment must be between 1 byte and 2 MB.');
      return;
    }
    if (this.uploadFiles.length + files.length > 4) {
      this.toast('Attach up to four files per message.');
      return;
    }
    this.uploadFiles.push(...files);
    this.renderAttachments();
  }
  renderAttachments() {
    this.el('chat-attachments').innerHTML = this.uploadFiles
      .map(
        (f, i) =>
          `<button type="button" class="file-chip" data-remove-file="${i}">${esc(f.name)} ×</button>`,
      )
      .join('');
    this.root.querySelectorAll<HTMLElement>('[data-remove-file]').forEach(
      (b) =>
        (b.onclick = () => {
          this.uploadFiles.splice(Number(b.dataset.removeFile), 1);
          this.renderAttachments();
        }),
    );
  }
  async send() {
    if (this.sending) return;
    const prompt = this.el<HTMLTextAreaElement>('chat-prompt'),
      input = prompt.value.trim();
    if (!input && !this.uploadFiles.length) return;
    if (input === '/new') {
      prompt.value = '';
      this.newChat();
      return;
    }
    if (input === '/stop') {
      prompt.value = '';
      await this.stop();
      return;
    }
    if (input.startsWith('/cd ')) {
      prompt.value = '';
      this.newChat(input.slice(4).trim());
      return;
    }
    if (input === '/help') {
      this.toast(
        '/new starts a conversation; /cd path selects a project; /stop cancels pending work. Attach images or files with + Attach.',
      );
      return;
    }
    if (this.el<HTMLButtonElement>('chat-send').disabled) return;
    this.sending = true;
    this.configure();
    try {
      const session = await this.ensureSession();
      const signature = JSON.stringify([
        session.id,
        input,
        this.uploadFiles.map((f) => [f.name, f.size, f.lastModified]),
      ]);
      if (
        !this.pendingSubmission ||
        this.pendingSubmission.signature !== signature
      ) {
        const ids = [];
        for (const file of this.uploadFiles) {
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          ids.push(
            (
              await this.api('/attachments', {
                sessionId: session.id,
                name: file.name,
                mime: file.type || 'application/octet-stream',
                data,
              })
            ).id,
          );
        }
        this.pendingSubmission = {
          signature,
          body: {
            id: crypto.randomUUID(),
            sessionId: session.id,
            deviceId: session.deviceId,
            executor: session.executor,
            cwd: session.cwd,
            input: input || 'Please examine the attached files.',
            attachmentIds: ids,
          },
        };
      }
      await this.api('/tasks', this.pendingSubmission.body);
      this.pendingSubmission = undefined;
      prompt.value = '';
      remember('draft.' + session.id, '');
      this.uploadFiles = [];
      this.renderAttachments();
      await this.load();
      await this.refresh(this.devices);
      this.el('chat-transcript').scrollTop =
        this.el('chat-transcript').scrollHeight;
    } catch (e) {
      this.toast((e as Error).message);
    } finally {
      this.sending = false;
      this.configure();
      prompt.focus();
    }
  }
  async stop() {
    try {
      await Promise.all(
        this.turns
          .filter((t) => !terminal.has(t.status))
          .map((t) => this.api('/tasks/' + t.id + '/cancel', {})),
      );
      await this.load();
    } catch (e) {
      this.toast((e as Error).message);
    }
  }
  async delete() {
    if (
      !this.conversation ||
      !window.confirm(
        'Delete this conversation, its messages, and uploaded files?',
      )
    )
      return;
    try {
      await this.api('/sessions/' + this.selected, undefined, 'DELETE');
      this.newChat();
      await this.refresh(this.devices);
    } catch (e) {
      this.toast((e as Error).message);
    }
  }
  async rename() {
    if (!this.conversation) return;
    const title = window.prompt('Conversation name', this.conversation.title);
    if (title?.trim())
      try {
        await this.api(
          '/sessions/' + this.selected,
          { title: title.trim() },
          'PATCH',
        );
        await this.refresh(this.devices);
      } catch (e) {
        this.toast((e as Error).message);
      }
  }
  async archive() {
    if (!this.conversation) return;
    try {
      await this.api(
        '/sessions/' + this.selected,
        { archived: !this.conversation.archived },
        'PATCH',
      );
      await this.refresh(this.devices);
    } catch (e) {
      this.toast((e as Error).message);
    }
  }
  async export() {
    if (!this.conversation) return;
    try {
      while (this.hasMore) await this.load(true);
      const text =
        '# ' +
        this.conversation.title +
        '\n\n' +
        this.turns
          .map(
            (t) =>
              '## You\n\n' +
              t.input +
              '\n\n## Veronica\n\n' +
              (this.cache
                .get(t.id)
                ?.events.filter((e) => e.kind === 'output')
                .map((e) => e.data.text)
                .join('') || '') +
              (t.error ? '\n\nError: ' + t.error : ''),
          )
          .join('\n\n---\n\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      a.download = 'veronica-conversation.md';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      this.toast((e as Error).message);
    }
  }
  dispose() {
    this.disposed = true;
  }
}
