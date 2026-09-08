const encoder = new TextEncoder();
export const configured = (secret?: string): secret is string =>
  !!secret && secret.length >= 32 && !secret.startsWith('replace-with-');
export async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const aa = await hash(a),
    bb = await hash(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++)
    diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return diff === 0;
}
export function randomToken(prefix = ''): string {
  return (
    prefix +
    Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function session(
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload = `${now + 12 * 60 * 60 * 1000}.${randomToken()}`;
  const sig = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encoder.encode(payload),
  );
  return (
    payload +
    '.' +
    Array.from(new Uint8Array(sig), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
export async function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    !/^\d+$/.test(parts[0]) ||
    !/^[a-f0-9]{48}$/.test(parts[1]) ||
    !/^[a-f0-9]{64}$/.test(parts[2])
  )
    return false;
  const expires = Number(parts[0]);
  if (expires <= now || expires > now + 12 * 60 * 60 * 1000) return false;
  const signature = Uint8Array.from(parts[2].match(/../g)!, (s) =>
    parseInt(s, 16),
  );
  return crypto.subtle.verify(
    'HMAC',
    await key(secret),
    signature,
    encoder.encode(parts.slice(0, 2).join('.')),
  );
}
export function cookie(request: Request): string {
  return (
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('veronica_session='))
      ?.slice(17) ?? ''
  );
}
