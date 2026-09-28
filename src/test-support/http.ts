/**
 * Minimal Next.js API route req/res doubles. No server is started; the
 * handler is invoked directly, so these tests cover the real HTTP layer
 * (status codes, error shapes) with zero network.
 */
export function mockReqRes(
  method: string,
  opts: {
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string | string[]>;
    remoteAddress?: string;
  } = {},
) {
  const req = {
    method,
    query: opts.query ?? {},
    body: opts.body,
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  res.setHeader = (k: string, v: string) => {
    res.headers[k] = v;
  };
  return { req, res };
}
