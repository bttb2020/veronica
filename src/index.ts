import { HttpError } from './protocol';
export { ControlRoom } from './room';
export interface Env {
  CONTROL: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/connect')
      return env.ASSETS.fetch(request);
    try {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin)
        throw new HttpError(403, 'Cross-origin requests are not allowed.');
      if (Number(request.headers.get('Content-Length') || 0) > 65536)
        throw new HttpError(413, 'Request too large.');
      // Materialize the bounded body before crossing the DO boundary. Endpoints
      // that reject a request early must not leave a live incoming body stream.
      let forwarded = request;
      if (request.body) {
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
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
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        forwarded = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bytes,
        });
      }
      return await env.CONTROL.get(env.CONTROL.idFromName('personal')).fetch(
        forwarded,
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Request failed', error);
      return Response.json(
        {
          error:
            status === 500
              ? 'Internal server error.'
              : (error as Error).message,
        },
        { status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
