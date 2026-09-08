import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = resolve(
  process.env.VERONICA_CLIENT_DIR || join(root, '../veronica-client'),
);
const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import(
  pathToFileURL(
    join(clientDir, 'node_modules/@agentclientprotocol/sdk/dist/acp.js'),
  )
);
const tmp = await mkdtemp(join(tmpdir(), 'veronica-e2e-'));
const home = join(tmp, 'profile'),
  project = join(tmp, 'project');
await mkdir(project);
const processes = [];
let workerLog = '',
  clientLog = '',
  server,
  proxy,
  deviceId,
  connectedProxy = true;
const connections = new Set();
const token = randomBytes(32).toString('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function child(command, args, options = {}) {
  const p = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  processes.push(p);
  return p;
}
async function run(command, args, options = {}) {
  const p = child(command, args, options);
  let output = '';
  p.stdout.on('data', (c) => (output += c));
  p.stderr.on('data', (c) => (output += c));
  const code = await new Promise((r, j) => {
    p.on('exit', r);
    p.on('error', j);
  });
  assert.equal(code, 0, output);
  return output;
}
async function waitFor(fn, label, timeout = 30000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await pause(150);
  }
  throw new Error(`Timed out: ${label}${last ? ' — ' + last.message : ''}`);
}
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function request(path, body, auth = token, method, extra = {}) {
  const response = await fetch(server + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}
async function ok(path, body, auth = token, method) {
  const r = await request(path, body, auth, method);
  assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function task(input, executor = 'shell', other = {}) {
  return (
    await ok('/api/tasks', { deviceId, input, executor, cwd: '.', ...other })
  ).task;
}
async function complete(id) {
  return waitFor(async () => {
    const r = await ok('/api/tasks/' + id);
    return (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        r.task.status,
      ) && r
    );
  }, 'task ' + id);
}
const output = (result) =>
  result.events
    .filter((e) => e.kind === 'output')
    .map((e) => e.data.text)
    .join('');
try {
  const port = await freePort();
  server = `http://127.0.0.1:${port}`;
  const worker = child(
    process.execPath,
    [
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--var',
      `ADMIN_TOKEN:${token}`,
      '--persist-to',
      join(tmp, 'state'),
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
    },
  );
  worker.stdout.on('data', (c) => (workerLog += c));
  worker.stderr.on('data', (c) => (workerLog += c));
  await waitFor(
    async () => {
      try {
        return (await request('/api/health', undefined, null)).data.configured;
      } catch {
        return false;
      }
    },
    'local Worker startup',
    60000,
  );
  assert.equal((await request('/api/me', undefined, null)).status, 401);
  assert.equal(
    (
      await request('/api/tasks', {}, token, undefined, {
        Origin: 'https://untrusted.example',
      })
    ).status,
    403,
  );
  const login = await request('/api/login', { token }, null);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await request('/api/me', undefined, null, undefined, { Cookie: cookie }))
      .status,
    200,
  );
  console.log(
    '✓ Authentication, signed browser cookie, and cross-origin rejection',
  );

  const wss = new WebSocketServer({ noServer: true });
  proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const response = await fetch(server + req.url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization
            ? { Authorization: req.headers.authorization }
            : {}),
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(502);
      res.end('{}');
    }
  });
  proxy.on('upgrade', (req, sock, head) => {
    if (!connectedProxy) {
      sock.destroy();
      return;
    }
    const upstream = new WebSocket(server.replace(/^http/, 'ws') + req.url, {
      headers: { Authorization: req.headers.authorization },
    });
    upstream.on('error', () => sock.destroy());
    upstream.on('open', () =>
      wss.handleUpgrade(req, sock, head, (downstream) => {
        connections.add(downstream);
        connections.add(upstream);
        downstream.on('message', (data) => {
          if (upstream.readyState === 1) upstream.send(data.toString());
        });
        upstream.on('message', (data) => {
          if (downstream.readyState === 1) downstream.send(data.toString());
        });
        downstream.on('close', () => {
          connections.delete(downstream);
          upstream.close(1012, 'Proxy closed');
        });
        upstream.on('close', (code) => {
          connections.delete(upstream);
          downstream.close(
            code === 1005 || code === 1006 ? 1012 : code,
            'Upstream closed',
          );
        });
        downstream.on('error', () => {});
      }),
    );
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const { code } = await ok('/api/pairings', { name: 'Studio workstation' });
  await run(
    process.execPath,
    [
      join(clientDir, 'dist/cli.js'),
      'pair',
      '--server',
      proxyOrigin,
      '--code',
      code,
      '--root',
      project,
      '--allow-shell',
      '--agent-command',
      JSON.stringify([
        process.execPath,
        join(clientDir, 'test/fake-agent.mjs'),
      ]),
    ],
    { env: { ...process.env, VERONICA_HOME: home } },
  );
  assert.equal((await request('/api/pair', { code }, null)).status, 401);
  deviceId = JSON.parse(
    await readFile(join(home, 'device.json'), 'utf8'),
  ).deviceId;
  function startDevice() {
    const p = child(
      process.execPath,
      [join(clientDir, 'dist/cli.js'), 'start'],
      { env: { ...process.env, VERONICA_HOME: home } },
    );
    p.stderr.on('data', (c) => (clientLog += c));
    return p;
  }
  let deviceProcess = startDevice();
  await waitFor(async () => {
    const d = (await ok('/api/devices')).devices[0];
    return d.online && d.capabilities.includes('agent');
  }, 'device connection');
  console.log(
    '✓ CLI pairing, one-use code, authenticated device connection, capability discovery',
  );
  const id = randomUUID(),
    input = `"${process.execPath}" -e "require('fs').appendFileSync('once.txt','x'); console.log('hello from Veronica')"`;
  const first = await task(input, 'shell', { id });
  assert.equal((await complete(first.id)).task.status, 'completed');
  assert.equal(output(await complete(first.id)).trim(), 'hello from Veronica');
  assert.equal((await task(input, 'shell', { id })).id, id);
  assert.equal(await readFile(join(project, 'once.txt'), 'utf8'), 'x');
  assert.equal(
    (
      await request('/api/tasks', {
        id,
        deviceId,
        input: 'different',
        executor: 'shell',
      })
    ).status,
    409,
  );
  const escaped = await task('echo should-not-run', 'shell', { cwd: '..' });
  assert.equal((await complete(escaped.id)).task.status, 'failed');
  console.log(
    '✓ Remote shell execution, output, idempotent submissions, working-directory checks',
  );

  const long = await task(
    `"${process.execPath}" -e "console.log('started');setTimeout(()=>console.log('finished offline'),1800)"`,
  );
  await waitFor(
    async () => output(await ok('/api/tasks/' + long.id)).includes('started'),
    'long task started',
  );
  connectedProxy = false;
  for (const ws of connections) ws.close(1012, 'Simulated network outage');
  await waitFor(
    async () => !(await ok('/api/devices')).devices[0].online,
    'device offline',
  );
  const queued = await task('echo queued-after-reconnect');
  assert.equal(queued.status, 'queued');
  await pause(2300);
  connectedProxy = true;
  assert.match(output(await complete(long.id)), /finished offline/);
  assert.match(output(await complete(queued.id)), /queued-after-reconnect/);
  console.log(
    '✓ Work continues offline, completed output replays, queued work resumes on reconnect',
  );

  const cancellable = await task(
    `"${process.execPath}" -e "console.log('ready');setTimeout(()=>{},30000)"`,
  );
  await waitFor(
    async () =>
      (await ok('/api/tasks/' + cancellable.id)).task.status === 'running',
    'cancellable task running',
  );
  await ok('/api/tasks/' + cancellable.id + '/cancel', {});
  assert.equal((await complete(cancellable.id)).task.status, 'cancelled');
  console.log('✓ Running task cancellation reaches the local process');

  const uncertain = await task(
    `"${process.execPath}" -e "require('fs').appendFileSync('crash-once.txt','x');console.log('crash-ready');setTimeout(()=>{},1200)"`,
  );
  await waitFor(
    async () =>
      output(await ok('/api/tasks/' + uncertain.id)).includes('crash-ready'),
    'task before client crash',
  );
  deviceProcess.kill('SIGKILL');
  await waitFor(() => deviceProcess.signalCode === 'SIGKILL', 'client crash');
  await pause(1500);
  deviceProcess = startDevice();
  assert.equal((await complete(uncertain.id)).task.status, 'interrupted');
  assert.equal(await readFile(join(project, 'crash-once.txt'), 'utf8'), 'x');
  console.log(
    '✓ Client crash recovery marks uncertain work interrupted without re-executing',
  );

  const sessionId = randomUUID();
  const agent1 = await task('first prompt', 'agent', { sessionId });
  assert.match(output(await complete(agent1.id)), /fixture turn 1/);
  const agent2 = await task('second prompt', 'agent', { sessionId });
  assert.match(output(await complete(agent2.id)), /fixture turn 2/);
  const permissionTask = await task('permission please', 'agent');
  const pending = await waitFor(async () => {
    const r = await ok('/api/tasks/' + permissionTask.id);
    return r.permissions[0] && r.permissions[0];
  }, 'agent permission');
  await ok('/api/tasks/' + permissionTask.id + '/permissions', {
    requestId: pending.requestId,
    optionId: 'allow',
  });
  assert.match(output(await complete(permissionTask.id)), /"optionId":"allow"/);
  console.log('✓ ACP agent sessions and permission approval round trip');

  const secondCode = (await ok('/api/pairings', { name: 'Other device' })).code;
  const other = await ok('/api/pair', { code: secondCode }, null);
  const operator = await ok('/api/operators', {
    name: 'WeChat operator',
    deviceId,
  });
  assert.equal(
    (await request('/api/pairings', { name: 'forbidden' }, operator.token))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        '/api/tasks',
        { deviceId: other.deviceId, input: 'x', executor: 'agent' },
        operator.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await ok('/api/devices', undefined, operator.token)).devices.length,
    1,
  );
  const gateway = child(
    process.execPath,
    [join(clientDir, 'dist/cli.js'), 'acp'],
    {
      env: {
        ...process.env,
        VERONICA_SERVER: server,
        VERONICA_DEVICE_ID: deviceId,
        VERONICA_OPERATOR_TOKEN: operator.token,
        VERONICA_HOME: join(tmp, 'operator'),
      },
    },
  );
  let gatewayOutput = '';
  gateway.stderr.on('data', (c) => (clientLog += c));
  const acp = new ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: ({ update }) => {
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
        )
          gatewayOutput += update.content.text;
      },
    }),
    ndJsonStream(Writable.toWeb(gateway.stdin), Readable.toWeb(gateway.stdout)),
  );
  await acp.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const session = await acp.newSession({ cwd: tmp, mcpServers: [] });
  await acp.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'through the operator' }],
  });
  assert.match(gatewayOutput, /through the operator/);
  await ok('/api/operators/' + operator.id, undefined, token, 'DELETE');
  assert.equal(
    (await request('/api/me', undefined, operator.token)).status,
    401,
  );
  console.log(
    '✓ Device-scoped operator authorization, stdio ACP gateway, key revocation',
  );

  if (process.env.VERONICA_BROWSER === '1') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(server);
      await page.getByLabel('Administrator key').waitFor();
      await page.screenshot({ path: join(tmp, 'login.png'), fullPage: true });
      await page.getByLabel('Administrator key').fill(token);
      await page.getByRole('button', { name: 'Enter workspace' }).click();
      await page.getByRole('heading', { name: 'Start something' }).waitFor();
      await page.getByLabel('Your task').fill('echo browser-task');
      await page.getByRole('button', { name: 'Run task', exact: true }).click();
      await page
        .locator('#terminal-output')
        .filter({ hasText: 'browser-task' })
        .waitFor();
      await page.waitForFunction(
        () => !document.querySelector('#toast')?.classList.contains('show'),
      );
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: 'instant' }),
      );
      await page.screenshot({ path: join(tmp, 'desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(tmp, 'mobile.png'), fullPage: true });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        'mobile must not overflow',
      );
      assert.deepEqual(errors, []);
      console.log(
        '✓ Browser sign-in, task submission, live output, and mobile layout',
      );
      if (process.env.VERONICA_ARTIFACT_DIR) {
        const { copyFile, mkdir } = await import('node:fs/promises');
        await mkdir(process.env.VERONICA_ARTIFACT_DIR, { recursive: true });
        for (const name of ['desktop.png', 'mobile.png', 'login.png'])
          await copyFile(
            join(tmp, name),
            join(process.env.VERONICA_ARTIFACT_DIR, name),
          );
      }
    } finally {
      await browser.close();
    }
  }

  const offlineOp = await ok('/api/operators', {
    name: 'Revoked with device',
    deviceId,
  });
  const active = await task(
    `"${process.execPath}" -e "setTimeout(()=>{},30000)"`,
  );
  await waitFor(
    async () => (await ok('/api/tasks/' + active.id)).task.status === 'running',
    'task before revocation',
  );
  await ok('/api/devices/' + deviceId, undefined, token, 'DELETE');
  assert.equal(
    (await ok('/api/tasks/' + active.id)).task.status,
    'interrupted',
  );
  assert.equal(
    (await request('/api/me', undefined, offlineOp.token)).status,
    401,
  );
  await waitFor(
    () => deviceProcess.exitCode !== null,
    'client exits after revocation',
  );
  console.log(
    '✓ Revoking a machine interrupts dispatch, stops its client, and revokes operators',
  );
  assert.doesNotMatch(
    workerLog,
    /Can't read from request stream after response has been sent/,
  );
  console.log('All end-to-end checks passed.');
} catch (error) {
  console.error(error);
  console.error('Worker diagnostics:\n' + workerLog.slice(-6000));
  console.error('Client diagnostics:\n' + clientLog.slice(-4000));
  process.exitCode = 1;
} finally {
  for (const p of processes.reverse())
    if (p.exitCode === null && !p.killed) p.kill('SIGTERM');
  for (const ws of connections) ws.terminate();
  proxy?.closeAllConnections();
  proxy?.close();
  await pause(1000);
  for (const p of processes) if (p.exitCode === null) p.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
}
