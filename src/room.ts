import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import {
  configured,
  cookie,
  equalSecret,
  hash,
  randomToken,
  session,
  verifySession,
} from './auth';
import {
  HttpError,
  requireString,
  TERMINAL,
  validateTask,
  VERSION,
} from './protocol';

type Row = Record<string, any>;
type Principal =
  | { role: 'admin' }
  | { role: 'operator'; deviceId: string; operatorId: string };
type Attachment =
  { role: 'device'; deviceId: string } | { role: 'browser'; expires: number };
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });

export class ControlRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, tokenHash TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, platform TEXT DEFAULT '', hostname TEXT DEFAULT '', root TEXT DEFAULT '', capabilities TEXT DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operators (id TEXT PRIMARY KEY, name TEXT NOT NULL, deviceId TEXT NOT NULL, tokenHash TEXT NOT NULL, createdAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, sessionId TEXT NOT NULL, executor TEXT NOT NULL, input TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastSeq INTEGER NOT NULL DEFAULT 0, exitCode INTEGER, error TEXT, outputBytes INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS tasks_device ON tasks(deviceId, createdAt);
      CREATE TABLE IF NOT EXISTS events (taskId TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(taskId, seq));
      CREATE TABLE IF NOT EXISTS permissions (taskId TEXT NOT NULL, requestId TEXT NOT NULL, data TEXT NOT NULL, outcome TEXT, PRIMARY KEY(taskId, requestId));
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resetAt INTEGER NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }
  rows(query: string, ...params: (string | number | null)[]): Row[] {
    return this.ctx.storage.sql.exec(query, ...params).toArray();
  }
  first(query: string, ...params: (string | number | null)[]): Row | undefined {
    return this.rows(query, ...params)[0];
  }
  deviceSocket(id: string) {
    return this.ctx
      .getWebSockets(`device:${id}`)
      .find((ws) => ws.readyState === 1);
  }
  send(ws: WebSocket | undefined, message: unknown) {
    try {
      ws?.send(JSON.stringify(message));
    } catch {
      /* Reconnection replays durable state. */
    }
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets('browser'))
      this.send(ws, { type: 'changed' });
  }
  async body(request: Request): Promise<Row> {
    if (!request.headers.get('Content-Type')?.startsWith('application/json'))
      throw new HttpError(415, 'Use application/json.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'JSON object required.');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new HttpError(413, 'Request too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    try {
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (!result || Array.isArray(result) || typeof result !== 'object')
        throw new Error();
      return result;
    } catch {
      throw new HttpError(400, 'JSON object required.');
    }
  }
  async principal(request: Request): Promise<Principal> {
    const bearer =
      request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
    if (bearer && (await equalSecret(bearer, this.env.ADMIN_TOKEN)))
      return { role: 'admin' };
    if (await verifySession(cookie(request), this.env.ADMIN_TOKEN))
      return { role: 'admin' };
    if (bearer.startsWith('vo_')) {
      const op = this.first(
        'SELECT * FROM operators WHERE tokenHash = ? AND revoked = 0',
        await hash(bearer),
      );
      if (
        op &&
        this.first(
          'SELECT id FROM devices WHERE id = ? AND revoked = 0',
          op.deviceId,
        )
      )
        return { role: 'operator', deviceId: op.deviceId, operatorId: op.id };
    }
    throw new HttpError(401, 'Sign in to your Veronica server.');
  }
  admin(p: Principal) {
    if (p.role !== 'admin')
      throw new HttpError(403, 'Administrator access required.');
  }
  access(p: Principal, deviceId: string) {
    if (p.role !== 'admin' && p.deviceId !== deviceId)
      throw new HttpError(403, 'This operator cannot access that device.');
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return json(
        {
          error:
            status === 500
              ? 'Internal server error.'
              : (error as Error).message,
        },
        status,
      );
    }
  }
  async route(request: Request): Promise<Response> {
    const { pathname: path, searchParams } = new URL(request.url);
    const method = request.method;
    if (path === '/api/health' && method === 'GET')
      return json({
        name: 'veronica',
        version: '0.1.0',
        protocol: VERSION,
        configured: configured(this.env.ADMIN_TOKEN),
      });
    if (!configured(this.env.ADMIN_TOKEN))
      throw new HttpError(
        503,
        'Set ADMIN_TOKEN to at least 32 random characters in your Cloudflare Worker secrets.',
      );
    if (path === '/api/login' && method === 'POST') {
      const ipHash = await hash(
        request.headers.get('CF-Connecting-IP') ?? 'local',
      );
      const now = Date.now();
      this.rows('DELETE FROM login_attempts WHERE resetAt <= ?', now);
      const attempt = this.first(
        'SELECT * FROM login_attempts WHERE key = ?',
        ipHash,
      );
      if (attempt && attempt.count >= 10)
        throw new HttpError(429, 'Too many attempts. Try again in 10 minutes.');
      this.rows(
        'INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1',
        ipHash,
        now + 600000,
      );
      const body = await this.body(request);
      if (
        typeof body.token !== 'string' ||
        !(await equalSecret(body.token, this.env.ADMIN_TOKEN))
      )
        throw new HttpError(401, 'The administrator key is incorrect.');
      this.rows('DELETE FROM login_attempts WHERE key = ?', ipHash);
      const secure =
        new URL(request.url).protocol === 'https:' ? '; Secure' : '';
      return json({ ok: true }, 200, {
        'Set-Cookie': `veronica_session=${await session(this.env.ADMIN_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
      });
    }
    if (path === '/api/logout' && method === 'POST')
      return json({ ok: true }, 200, {
        'Set-Cookie':
          'veronica_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
    if (path === '/api/pair' && method === 'POST') {
      const body = await this.body(request);
      const codeHash = await hash(requireString(body.code, 'code', 100));
      const deviceToken = randomToken('vd_');
      const tokenHash = await hash(deviceToken);
      let device: Row | undefined;
      this.ctx.storage.transactionSync(() => {
        const pairing = this.first(
          'SELECT * FROM pairings WHERE hash = ? AND expires > ?',
          codeHash,
          Date.now(),
        );
        if (!pairing)
          throw new HttpError(
            401,
            'Pairing code is invalid, expired, or already used.',
          );
        if (
          this.first('SELECT COUNT(*) AS n FROM devices WHERE revoked = 0')!
            .n >= 100
        )
          throw new HttpError(409, 'Device limit reached (100).');
        this.rows('DELETE FROM pairings WHERE hash = ?', codeHash);
        device = { id: crypto.randomUUID(), name: pairing.name };
        this.rows(
          'INSERT INTO devices(id,name,tokenHash,createdAt,lastSeen) VALUES (?,?,?,?,?)',
          device.id,
          device.name,
          tokenHash,
          Date.now(),
          Date.now(),
        );
      });
      this.broadcast();
      return json(
        {
          deviceId: device!.id,
          name: device!.name,
          token: deviceToken,
          protocol: VERSION,
        },
        201,
      );
    }
    if (path === '/connect' && method === 'GET') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        throw new HttpError(426, 'WebSocket required.');
      const bearer =
        request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
      const device = this.first(
        'SELECT * FROM devices WHERE tokenHash = ? AND revoked = 0',
        await hash(bearer),
      );
      if (!device)
        throw new HttpError(401, 'Device credentials are invalid or revoked.');
      for (const previous of this.ctx.getWebSockets(`device:${device.id}`))
        previous.close(4001, 'Replaced by a new connection');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`device:${device.id}`]);
      pair[1].serializeAttachment({
        role: 'device',
        deviceId: device.id,
      } satisfies Attachment);
      this.send(pair[1], { type: 'welcome', v: VERSION });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const p = await this.principal(request);
    if (path === '/api/me' && method === 'GET') return json(p);
    if (path === '/api/events' && method === 'GET') {
      this.admin(p);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        throw new HttpError(426, 'WebSocket required.');
      if (this.ctx.getWebSockets('browser').length >= 20)
        throw new HttpError(429, 'Too many dashboard connections.');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['browser']);
      pair[1].serializeAttachment({
        role: 'browser',
        expires: Date.now() + 12 * 3600000,
      } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === '/api/pairings' && method === 'POST') {
      this.admin(p);
      const body = await this.body(request);
      const name = requireString(body.name, 'name', 80);
      const code = randomToken('vp_');
      const expiresAt = Date.now() + 600000;
      this.rows('DELETE FROM pairings WHERE expires <= ?', Date.now());
      this.rows(
        'INSERT INTO pairings VALUES (?,?,?)',
        await hash(code),
        name,
        expiresAt,
      );
      return json({ code, expiresAt }, 201);
    }
    if (path === '/api/devices' && method === 'GET') {
      const devices = this.rows(
        'SELECT id,name,createdAt,lastSeen,platform,hostname,root,capabilities FROM devices WHERE revoked = 0 ORDER BY createdAt',
      );
      return json({
        devices: devices
          .filter((d) => p.role === 'admin' || p.deviceId === d.id)
          .map((d) => ({
            ...d,
            online: !!this.deviceSocket(d.id),
            capabilities: JSON.parse(d.capabilities),
          })),
      });
    }
    const deviceRoute = path.match(/^\/api\/devices\/([^/]+)$/);
    if (deviceRoute && method === 'DELETE') {
      this.admin(p);
      const id = deviceRoute[1];
      this.rows('UPDATE devices SET revoked=1 WHERE id=?', id);
      this.rows('UPDATE operators SET revoked=1 WHERE deviceId=?', id);
      for (const task of this.rows(
        "SELECT * FROM tasks WHERE deviceId=? AND status NOT IN ('completed','failed','cancelled','interrupted')",
        id,
      )) {
        this.send(this.deviceSocket(id), { type: 'cancel', taskId: task.id });
        this.rows(
          "UPDATE tasks SET status='interrupted',error='Device revoked. Execution may have continued while disconnected.',updatedAt=? WHERE id=?",
          Date.now(),
          task.id,
        );
      }
      for (const ws of this.ctx.getWebSockets(`device:${id}`))
        ws.close(4003, 'Device revoked');
      this.broadcast();
      return json({ ok: true });
    }
    if (path === '/api/operators' && method === 'GET') {
      this.admin(p);
      return json({
        operators: this.rows(
          'SELECT id,name,deviceId,createdAt FROM operators WHERE revoked=0 ORDER BY createdAt DESC',
        ),
      });
    }
    if (path === '/api/operators' && method === 'POST') {
      this.admin(p);
      const body = await this.body(request);
      const name = requireString(body.name, 'name', 80),
        deviceId = requireString(body.deviceId, 'deviceId', 80);
      if (
        !this.first('SELECT id FROM devices WHERE id=? AND revoked=0', deviceId)
      )
        throw new HttpError(404, 'Device not found.');
      const id = crypto.randomUUID(),
        token = randomToken('vo_');
      this.rows(
        'INSERT INTO operators(id,name,deviceId,tokenHash,createdAt) VALUES (?,?,?,?,?)',
        id,
        name,
        deviceId,
        await hash(token),
        Date.now(),
      );
      return json({ id, token, deviceId }, 201);
    }
    const opRoute = path.match(/^\/api\/operators\/([^/]+)$/);
    if (opRoute && method === 'DELETE') {
      this.admin(p);
      this.rows('UPDATE operators SET revoked=1 WHERE id=?', opRoute[1]);
      return json({ ok: true });
    }
    if (path === '/api/tasks' && method === 'GET') {
      const deviceId =
        p.role === 'operator' ? p.deviceId : searchParams.get('deviceId');
      const tasks = deviceId
        ? this.rows(
            'SELECT * FROM tasks WHERE deviceId=? ORDER BY createdAt DESC LIMIT 100',
            deviceId,
          )
        : this.rows('SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 100');
      return json({ tasks });
    }
    if (path === '/api/tasks' && method === 'POST') {
      const body = await this.body(request),
        data = validateTask(body);
      this.access(p, data.deviceId);
      const id =
        body.id === undefined
          ? crypto.randomUUID()
          : requireString(body.id, 'id', 100);
      const existing = this.first('SELECT * FROM tasks WHERE id=?', id);
      if (existing) {
        this.access(p, existing.deviceId);
        if (
          existing.deviceId !== data.deviceId ||
          existing.input !== data.input ||
          existing.executor !== data.executor ||
          existing.cwd !== data.cwd ||
          (body.sessionId !== undefined &&
            existing.sessionId !== data.sessionId)
        )
          throw new HttpError(
            409,
            'Task id already used with different input.',
          );
        return json({ task: existing });
      }
      const device = this.first(
        'SELECT * FROM devices WHERE id=? AND revoked=0',
        data.deviceId,
      );
      if (!device) throw new HttpError(404, 'Device not found.');
      if (!JSON.parse(device.capabilities).includes(data.executor))
        throw new HttpError(
          409,
          `This device has not enabled the ${data.executor} executor. Connect it with that capability first.`,
        );
      if (
        this.first(
          "SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled','interrupted')",
        )!.n >= 100
      )
        throw new HttpError(429, 'Queue is full (100 unfinished tasks).');
      if (this.first('SELECT COUNT(*) AS n FROM tasks')!.n >= 1000)
        throw new HttpError(
          409,
          'History is full (1,000 tasks). Delete old finished tasks to continue.',
        );
      this.rows(
        'INSERT INTO tasks(id,deviceId,sessionId,executor,input,cwd,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
        id,
        data.deviceId,
        data.sessionId,
        data.executor,
        data.input,
        data.cwd,
        'queued',
        Date.now(),
        Date.now(),
      );
      this.dispatch(data.deviceId);
      this.broadcast();
      return json(
        { task: this.first('SELECT * FROM tasks WHERE id=?', id) },
        201,
      );
    }
    const taskRoute = path.match(
      /^\/api\/tasks\/([^/]+)(?:\/(cancel|permissions))?$/,
    );
    if (taskRoute) {
      const task = this.first('SELECT * FROM tasks WHERE id=?', taskRoute[1]);
      if (!task) throw new HttpError(404, 'Task not found.');
      this.access(p, task.deviceId);
      if (!taskRoute[2] && method === 'GET') {
        const after = Math.max(0, Number(searchParams.get('after')) || 0);
        return json({
          task,
          events: this.rows(
            'SELECT * FROM events WHERE taskId=? AND seq>? ORDER BY seq LIMIT 200',
            task.id,
            after,
          ).map((e) => ({ ...e, data: JSON.parse(e.data) })),
          permissions: this.rows(
            'SELECT * FROM permissions WHERE taskId=? AND outcome IS NULL',
            task.id,
          ).map((e) => ({ ...e, data: JSON.parse(e.data) })),
        });
      }
      if (!taskRoute[2] && method === 'DELETE') {
        if (!TERMINAL.has(task.status))
          throw new HttpError(409, 'Cancel the task before deleting it.');
        this.ctx.storage.transactionSync(() => {
          this.rows('DELETE FROM permissions WHERE taskId=?', task.id);
          this.rows('DELETE FROM events WHERE taskId=?', task.id);
          this.rows('DELETE FROM tasks WHERE id=?', task.id);
        });
        this.broadcast();
        return json({ ok: true });
      }
      if (taskRoute[2] === 'cancel' && method === 'POST') {
        if (!TERMINAL.has(task.status)) {
          this.rows(
            'UPDATE tasks SET status=?,updatedAt=? WHERE id=?',
            task.status === 'queued' ? 'cancelled' : 'cancelling',
            Date.now(),
            task.id,
          );
          this.send(this.deviceSocket(task.deviceId), {
            type: 'cancel',
            taskId: task.id,
          });
          this.broadcast();
        }
        return json({ ok: true });
      }
      if (taskRoute[2] === 'permissions' && method === 'POST') {
        const body = await this.body(request),
          requestId = requireString(body.requestId, 'requestId', 100);
        const permission = this.first(
          'SELECT * FROM permissions WHERE taskId=? AND requestId=?',
          task.id,
          requestId,
        );
        if (!permission || TERMINAL.has(task.status))
          throw new HttpError(409, 'Permission request is no longer pending.');
        const options = JSON.parse(permission.data).options;
        const outcome =
          body.optionId === null
            ? { outcome: 'cancelled' }
            : {
                outcome: 'selected',
                optionId: requireString(body.optionId, 'optionId', 100),
              };
        if (
          'optionId' in outcome &&
          !options.some((o: Row) => o.optionId === outcome.optionId)
        )
          throw new HttpError(400, 'Invalid permission option.');
        if (
          permission.outcome &&
          permission.outcome !== JSON.stringify(outcome)
        )
          throw new HttpError(409, 'Permission already answered.');
        this.rows(
          'UPDATE permissions SET outcome=? WHERE taskId=? AND requestId=?',
          JSON.stringify(outcome),
          task.id,
          requestId,
        );
        this.send(this.deviceSocket(task.deviceId), {
          type: 'permission.response',
          taskId: task.id,
          requestId,
          outcome,
        });
        this.broadcast();
        return json({ ok: true });
      }
    }
    throw new HttpError(404, 'Endpoint not found.');
  }
  dispatch(deviceId: string, replay = false) {
    const ws = this.deviceSocket(deviceId);
    if (!ws) return;
    const active = this.first(
      "SELECT * FROM tasks WHERE deviceId=? AND status IN ('dispatched','running','cancelling') ORDER BY createdAt LIMIT 1",
      deviceId,
    );
    if (active) {
      if (replay) {
        this.send(ws, { type: 'task', task: active });
        if (active.status === 'cancelling')
          this.send(ws, { type: 'cancel', taskId: active.id });
        for (const perm of this.rows(
          'SELECT * FROM permissions WHERE taskId=? AND outcome IS NOT NULL',
          active.id,
        ))
          this.send(ws, {
            type: 'permission.response',
            taskId: active.id,
            requestId: perm.requestId,
            outcome: JSON.parse(perm.outcome),
          });
      }
      return;
    }
    const next = this.first(
      "SELECT * FROM tasks WHERE deviceId=? AND status='queued' ORDER BY createdAt,rowid LIMIT 1",
      deviceId,
    );
    if (!next) return;
    this.rows(
      "UPDATE tasks SET status='dispatched',updatedAt=? WHERE id=?",
      Date.now(),
      next.id,
    );
    this.send(ws, { type: 'task', task: { ...next, status: 'dispatched' } });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.role === 'browser') {
      if (attachment.expires < Date.now()) ws.close(4003, 'Session expired');
      return;
    }
    try {
      if (typeof raw !== 'string' || raw.length > 65536)
        throw new Error('Invalid frame');
      const message = JSON.parse(raw),
        deviceId = attachment.deviceId;
      const device = this.first(
        'SELECT id FROM devices WHERE id=? AND revoked=0',
        deviceId,
      );
      if (!device || this.deviceSocket(deviceId) !== ws) {
        ws.close(4003, 'Connection no longer authorized');
        return;
      }
      this.rows(
        'UPDATE devices SET lastSeen=? WHERE id=?',
        Date.now(),
        deviceId,
      );
      if (message.type === 'hello') {
        if (message.v !== VERSION) {
          ws.close(4002, 'Unsupported protocol version');
          return;
        }
        const capabilities = Array.isArray(message.capabilities)
          ? message.capabilities.filter(
              (c: unknown) => c === 'shell' || c === 'agent',
            )
          : [];
        this.rows(
          'UPDATE devices SET platform=?,hostname=?,root=?,capabilities=? WHERE id=?',
          String(message.platform ?? '').slice(0, 100),
          String(message.hostname ?? '').slice(0, 100),
          String(message.root ?? '').slice(0, 1024),
          JSON.stringify(capabilities),
          deviceId,
        );
        this.dispatch(deviceId, true);
        this.broadcast();
        return;
      }
      if (message.type !== 'event') throw new Error('Unknown message');
      const { taskId, seq, kind, data } = message;
      if (
        typeof taskId !== 'string' ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        !data ||
        typeof data !== 'object'
      )
        throw new Error('Invalid event');
      const task = this.first(
        'SELECT * FROM tasks WHERE id=? AND deviceId=?',
        taskId,
        deviceId,
      );
      if (!task) {
        this.send(ws, { type: 'ack', taskId, seq });
        return;
      }
      if (seq <= task.lastSeq || TERMINAL.has(task.status)) {
        this.send(ws, { type: 'ack', taskId, seq });
        return;
      }
      if (seq !== task.lastSeq + 1) {
        this.send(ws, { type: 'replay', taskId, after: task.lastSeq });
        return;
      }
      if (!['accepted', 'output', 'permission', 'finished'].includes(kind))
        throw new Error('Invalid event kind');
      if (
        kind === 'output' &&
        (typeof data.text !== 'string' ||
          data.text.length > 20000 ||
          !['stdout', 'stderr', 'agent'].includes(data.stream))
      )
        throw new Error('Invalid output');
      if (
        kind === 'finished' &&
        (!TERMINAL.has(data.status) ||
          (data.exitCode != null && !Number.isSafeInteger(data.exitCode)) ||
          (data.error != null && typeof data.error !== 'string'))
      )
        throw new Error('Invalid completion');
      if (
        kind === 'permission' &&
        (typeof data.requestId !== 'string' ||
          data.requestId.length > 100 ||
          !Array.isArray(data.options) ||
          data.options.length > 20 ||
          !data.options.every(
            (o: Row) =>
              typeof o.optionId === 'string' && typeof o.name === 'string',
          ))
      )
        throw new Error('Invalid permission');
      const encoded = JSON.stringify(data);
      this.ctx.storage.transactionSync(() => {
        if (kind === 'output' && task.outputBytes + encoded.length > 1500000) {
          this.rows(
            "UPDATE tasks SET status='failed',error='Output limit exceeded.',updatedAt=? WHERE id=?",
            Date.now(),
            taskId,
          );
        } else {
          this.rows(
            'INSERT INTO events VALUES (?,?,?,?,?)',
            taskId,
            seq,
            kind,
            encoded,
            Date.now(),
          );
          this.rows(
            'UPDATE tasks SET lastSeq=?,updatedAt=?,outputBytes=outputBytes+? WHERE id=?',
            seq,
            Date.now(),
            kind === 'output' ? encoded.length : 0,
            taskId,
          );
          if (kind === 'accepted' && task.status !== 'cancelling')
            this.rows("UPDATE tasks SET status='running' WHERE id=?", taskId);
          if (kind === 'permission')
            this.rows(
              'INSERT OR IGNORE INTO permissions(taskId,requestId,data) VALUES (?,?,?)',
              taskId,
              data.requestId,
              encoded,
            );
          if (kind === 'finished') {
            this.rows(
              'UPDATE tasks SET status=?,exitCode=?,error=? WHERE id=?',
              data.status,
              data.exitCode ?? null,
              data.error?.slice(0, 2000) ?? null,
              taskId,
            );
            this.rows(
              "UPDATE permissions SET outcome='{}' WHERE taskId=? AND outcome IS NULL",
              taskId,
            );
          }
        }
      });
      this.send(ws, { type: 'ack', taskId, seq });
      this.broadcast();
      if (kind === 'finished') this.dispatch(deviceId);
      else if (
        this.first('SELECT status FROM tasks WHERE id=?', taskId)?.status ===
        'failed'
      ) {
        this.send(ws, { type: 'cancel', taskId });
        this.dispatch(deviceId);
      }
    } catch (error) {
      console.error('Invalid device message', error);
      ws.close(4002, 'Invalid protocol message');
    }
  }
  webSocketClose(ws: WebSocket, code: number) {
    const a = ws.deserializeAttachment() as Attachment;
    try {
      ws.close(code, 'Closed');
    } catch {}
    if (a.role === 'device') this.broadcast();
  }
  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, 'Connection error');
    } catch {}
    this.broadcast();
  }
}
