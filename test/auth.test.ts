import { describe, expect, it } from 'vitest';
import {
  configured,
  cookie,
  equalSecret,
  session,
  verifySession,
} from '../src/auth';
import { validateTask } from '../src/protocol';
describe('administrator sessions', () => {
  const secret = 'a-secure-test-key-with-at-least-thirty-two-characters';
  it('rejects unconfigured and example secrets', () => {
    expect(configured('short')).toBe(false);
    expect(configured('replace-with-at-least-32-random-characters')).toBe(
      false,
    );
    expect(configured(secret)).toBe(true);
  });
  it('accepts only a valid, unexpired signature under the current secret', async () => {
    const token = await session(secret, 1000);
    expect(await verifySession(token, secret, 1001)).toBe(true);
    expect(await verifySession(token, secret, 1000 + 12 * 3600000)).toBe(false);
    expect(await verifySession(token, secret + 'rotated', 1001)).toBe(false);
    expect(await verifySession('9' + token, secret, 1001)).toBe(false);
    expect(await verifySession('invalid', secret, 1001)).toBe(false);
  });
  it('compares secret values and reads the exact session cookie', async () => {
    expect(await equalSecret('abc', 'abc')).toBe(true);
    expect(await equalSecret('abc', 'abd')).toBe(false);
    expect(
      cookie(
        new Request('https://example.test', {
          headers: { Cookie: 'other=123; veronica_session=abc.def; more=4' },
        }),
      ),
    ).toBe('abc.def');
  });
});
describe('task boundary', () => {
  it('accepts supported executors with explicit defaults', () => {
    expect(
      validateTask({
        deviceId: 'device',
        input: 'pwd',
        executor: 'shell',
        sessionId: 'conversation',
      }),
    ).toEqual({
      deviceId: 'device',
      input: 'pwd',
      executor: 'shell',
      cwd: '.',
      sessionId: 'conversation',
    });
  });
  it('rejects empty, oversized and unsupported input', () => {
    for (const value of [
      { deviceId: '', input: 'pwd', executor: 'shell' },
      { deviceId: 'd', input: ' ', executor: 'shell' },
      { deviceId: 'd', input: 'x'.repeat(32001), executor: 'shell' },
      { deviceId: 'd', input: 'pwd', executor: 'unknown' },
    ])
      expect(() => validateTask(value)).toThrow();
  });
});
