# Operating your personal server

## Secrets and access

Store `ADMIN_TOKEN` as a Cloudflare Worker secret. Rotate it with `wrangler secret put ADMIN_TOKEN`; rotation invalidates previously signed browser sessions. Device and operator keys are independent. Revoke them in the dashboard when a machine or integration should lose access.

Only give access to people and integrations you trust to act as your operating-system user. A device-scoped operator can run enabled executors on that device and read its task history. Shell execution and an agent's own tools are not sandboxed. Use a separate OS user, container, or VM if you need process isolation.

## Uptime and recovery

Run `veronica-client service install` from a normal Linux or macOS login session. It installs an OS-managed user service. Use `service status`, `service logs`, `service restart`, `service stop`, or `service uninstall`. `start` remains a foreground command. On a Linux server, user lingering must be enabled by its administrator if the service should survive logout; macOS LaunchAgents start at login. The machine must remain powered on, awake, and able to reach your server. An outbound HTTPS/WebSocket connection is required; no inbound port is opened.

Cloudflare deployments and network changes can disconnect WebSockets. Client reconnect uses exponential backoff and jitter; its task journal supplies duplicate suppression and replay. DO business state lives in SQLite, while connections use Hibernation. Avoid removing the DO migration or binding when updating the Worker.

An unexpected client restart marks unfinished local tasks interrupted. Inspect actual repository/process state before running a new task. A process or its detached descendants may have produced side effects before a crash; this system does not provide transactions over shell commands.

Conversation titles, messages, output, attachment metadata and archive state are durable in the server. Agent session IDs are stored privately on the client. If the adapter advertises `loadSession`, Veronica restores its session after restart or eviction from the ten-session process cache and suppresses the adapter’s history replay to avoid duplicated messages. A restore failure is shown as an error instead of silently starting over. Adapters without that capability start a fresh context and emit an explicit progress notice; cloud history remains available.

## Retention and limits

The cloud retains up to 1,000 task records. Delete completed records in the dashboard to free space. Deletion also removes their cloud output and pending-permission records. Local client journals remain until the operator removes the retired profile; they can contain sensitive task inputs and outputs and should be protected like source code.

The conversation toolbar exports Markdown or deletes a finished conversation and its uploaded files. Cloud attachments are limited to 2 MB each, four per turn and 50 MB per personal server. Downloaded files live in `.veronica-inbox` under the machine root; cloud deletion does not remove those local copies. There is no automatic retention policy. Account for the storage limits and pricing of your Cloudflare plan. Requests and active Durable Object work are metered; Hibernation reduces idle duration costs but does not eliminate all charges.

## Troubleshooting

| Symptom                                    | Check                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| API says not configured                    | Worker `ADMIN_TOKEN` is at least 32 characters and differs from the placeholder             |
| Pairing code rejected                      | It expired, was already used, or belongs to another server                                  |
| Device exists but no executor is available | Start the paired client; check its log and configured capabilities                          |
| Offline device                             | Power/sleep state, `veronica-client status`, outbound TLS access, proxy/firewall rules      |
| Queued task does not start                 | A previous task may still be active or waiting for approval on the same device              |
| Running task shows no output               | The process may buffer stdout, wait for input, or need an agent permission decision         |
| ACP agent fails to start                   | Run the configured executable and arguments locally; complete that agent's login            |
| WeChat gateway cannot run                  | Operator key/device match, ACP agent enabled on the target machine, iLink account available |
| Task interrupted                           | Check local side effects and start a new task only after reconciling them                   |

The client supports noninteractive processes, not terminal PTYs. Commands that ask for an interactive password or stdin will not work. Authenticate the agent and development tools on the execution machine before connecting them.

## Deployment verification

The repository's CI checks TypeScript, formatting, unit tests, a Worker dry-run bundle, and an end-to-end test using Cloudflare's local runtime plus the separate client repository. Browser checks use Chromium. These checks do not provision a public Worker or log in to WeChat; validate the deployed instance and your actual network path after deploying.
