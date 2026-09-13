# Veronica protocol v1

One personal server owns one logical Durable Object, addressed with `idFromName('personal')`. All device ids and task ids are scoped to that instance.

## Authentication

- Administrator: `Authorization: Bearer ADMIN_TOKEN`, or the signed, expiring `HttpOnly; SameSite=Strict` cookie returned by `POST /api/login`. Cookies are Secure on HTTPS.
- Device: a `vd_…` bearer token issued once by `/api/pair`; accepted only at `/connect`.
- Operator: a `vo_…` bearer token scoped to a device. Can list that device, read its tasks, submit/cancel/delete its tasks, and respond to its task permissions. Cannot manage devices, administrators, or operator credentials.
- Pairing: a random, single-use `vp_…` code, expires after ten minutes.

Device, pairing and operator credentials are hashed in DO storage. Cross-origin browser requests are rejected; no cross-origin API access or credentials in URL queries. Use TLS except for localhost development. Login allows ten attempts per IP per ten minutes.

## HTTP API

JSON request bodies use `Content-Type: application/json` and are limited to 64 KiB. Errors are `{ "error": "…" }` with an appropriate non-2xx status.

| Method        | Endpoint                     | Purpose                                               |
| ------------- | ---------------------------- | ----------------------------------------------------- |
| GET           | `/api/health`                | Public version and configuration health               |
| POST          | `/api/login`                 | `{token}` → administrator session cookie              |
| POST          | `/api/logout`                | Clear browser cookie                                  |
| GET           | `/api/me`                    | Current principal and scope                           |
| POST          | `/api/pairings`              | Admin `{name}` → `{code, expiresAt}`                  |
| POST          | `/api/pair`                  | Public `{code}` → `{deviceId, name, token, protocol}` |
| GET           | `/api/devices`               | `{devices}` with online status and capabilities       |
| DELETE        | `/api/devices/:id`           | Admin revoke device and its operators                 |
| GET / POST    | `/api/operators`             | Admin list or create `{name, deviceId}`               |
| DELETE        | `/api/operators/:id`         | Admin revoke an operator                              |
| GET           | `/api/tasks?deviceId=…`      | Latest 100 accessible tasks                           |
| POST          | `/api/tasks`                 | Submit a task; accepts an optional idempotency `id`   |
| GET           | `/api/tasks/:id?after=0`     | Task, next 200 events, unanswered permissions         |
| POST          | `/api/tasks/:id/cancel`      | Request cancellation                                  |
| POST          | `/api/tasks/:id/permissions` | `{requestId, optionId}`; `null` dismisses             |
| DELETE        | `/api/tasks/:id`             | Delete a finished task and its cloud output           |
| GET + Upgrade | `/api/events`                | Admin browser invalidation notifications              |
| GET + Upgrade | `/connect`                   | Device WebSocket                                      |

Example task:

```json
{
  "id": "unique-task-id",
  "deviceId": "registered-device-id",
  "sessionId": "conversation-id",
  "executor": "agent",
  "cwd": "my-project",
  "input": "Investigate the failing test and report your findings."
}
```

Executors are `shell` and `agent`. Devices advertise the enabled executors on connection. Shell input is deliberately executed by the host shell; agent input is a text prompt sent to an independently configured ACP process. The cloud cannot supply an alternative agent executable.

Reusing a task id with identical fields returns its existing task. Different input with that id is a conflict. Use a new id to intentionally run again. Idempotency records are removed from the server when the task is deleted; clients still retain their local task tombstones and will not repeat the same id.

## WebSocket

Every connection begins with server `{type:"welcome",v:1}` and client:

```json
{
  "type": "hello",
  "v": 1,
  "platform": "linux",
  "hostname": "studio",
  "root": "/work",
  "capabilities": ["shell", "agent"]
}
```

Client text `ping` receives text `pong` through Cloudflare's auto-response API, without invoking JavaScript. All other frames are JSON, maximum 64 KiB.

Server messages:

- `{type:"task",task:{…}}`: new assignment or reconnect reconciliation.
- `{type:"cancel",taskId}`: cancel the active task.
- `{type:"permission.response",taskId,requestId,outcome}`: persisted ACP permission response.
- `{type:"ack",taskId,seq}`: event is stored or already represented by a terminal task.
- `{type:"replay",taskId,after}`: retransmit events after the last contiguous stored sequence.

Client events:

```json
{"type":"event","taskId":"…","seq":1,"kind":"accepted","data":{}}
{"type":"event","taskId":"…","seq":2,"kind":"output","data":{"stream":"stdout","text":"hello\n"}}
{"type":"event","taskId":"…","seq":3,"kind":"finished","data":{"status":"completed","exitCode":0,"error":null}}
```

`permission` events contain `{requestId, options, toolCall}`. Output streams are `stdout`, `stderr`, `agent`. Sequence numbers start at 1 and increase per task. DO storage commits accepted events before acknowledging. Duplicate events do not append twice; sequence gaps trigger replay.

Client records are kept in `~/.veronica/journal/<deviceId>`. They are written before execution and before transmission. In v0.1 acknowledgements do not prune local logs; this keeps reconnect/reconciliation simple and prevents uncertain work from being repeated. Provision disk space and retire old profiles deliberately.

## State and cancellation

```text
queued → dispatched → running → completed / failed
   └→ cancelled          └→ cancelling → cancelled / failed
dispatched / running / cancelling → interrupted (restart or device revocation)
```

A disconnected device retains its active assignment. A new task waits behind it. Reconnect delivers the active task first; the client's journal prevents duplicate execution and retransmits its events. Once it finishes, the DO dispatches the next queued task.

Cancellation during disconnection remains pending. Revocation closes the credential's connection and marks outstanding tasks interrupted, but cannot immediately stop a process on an offline computer. Reconnecting with a revoked credential fails and the client shuts down its active work.

Browser sockets carry only `{type:"changed"}`. The dashboard then reads authenticated state and sequential output pages. This keeps task data out of stale browser socket notifications.

## Conversations and attachments (v0.2)

Protocol version remains 1. The server `welcome` advertises optional `features: ["activity", "attachments", "sessions"]`. New clients send rich `activity` events only when the server advertises support. Existing clients can keep sending the original event types.

- `GET /api/sessions?archived=true&q=...`: latest 200 matching conversations, restricted to the operator's device when applicable.
- `POST /api/sessions`: `{deviceId, executor, cwd, title?}` creates a conversation.
- `GET /api/sessions/:id?before=<cursor>`: up to 50 turns in chronological order and attachment metadata. Use the oldest returned cursor to load earlier turns.
- `PATCH /api/sessions/:id`: `{title?, archived?}`.
- `DELETE /api/sessions/:id`: deletes a finished conversation, turns, events and cloud attachments. Unfinished work must be stopped first.
- `POST /api/attachments`: authenticated `{sessionId, name, mime, data}` with base64 data, at most 2 MB decoded. Returns attachment ID.
- `GET /api/attachments/:id`: authenticated download with attachment disposition.
- `GET /api/device/attachments/:id`: device bearer authentication; returns file data only for a conversation assigned to that device.
- `POST /api/tasks` additionally accepts `attachmentIds: string[]`. IDs must belong to the task's conversation. The stored task exposes `attachmentIds` as a JSON-encoded list for wire compatibility.

A conversation cannot switch machine, executor or working directory after creation. A reused task ID must match its attachment IDs too. All conversation routes enforce the same administrator/operator scope as tasks. `activity` events carry bounded `{kind, title, status?, text?}`; clients treat these as display data.
