export const VERSION = 1;
export const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type Executor = 'shell' | 'agent';
export interface Task {
  id: string;
  deviceId: string;
  sessionId: string;
  executor: Executor;
  input: string;
  cwd: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  exitCode: number | null;
  error: string | null;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(
      400,
      `${name} must be a non-empty string, at most ${max} characters.`,
    );
  }
  return value;
}
export function validateTask(value: Record<string, unknown>) {
  const deviceId = requireString(value.deviceId, 'deviceId', 80);
  const input = requireString(value.input, 'input', 32000);
  if (value.executor !== 'shell' && value.executor !== 'agent')
    throw new HttpError(400, 'Unknown executor.');
  const cwd =
    value.cwd === undefined ? '.' : requireString(value.cwd, 'cwd', 1024);
  const sessionId =
    value.sessionId === undefined
      ? crypto.randomUUID()
      : requireString(value.sessionId, 'sessionId', 100);
  return { deviceId, input, executor: value.executor, cwd, sessionId };
}
