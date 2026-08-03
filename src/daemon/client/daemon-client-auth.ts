// Transport credentials are process-local request context. Keeping them out of
// the enumerable command request prevents accidental RPC, recording, and
// diagnostics serialization while preserving the authentication channel used
// by remote HTTP and local socket transports.
const authTokenByRequest = new WeakMap<object, string>();

export function attachDaemonRequestAuthToken<TRequest extends object>(
  request: TRequest,
  token: string | undefined,
): TRequest {
  if (token?.trim()) authTokenByRequest.set(request, token);
  return request;
}

export function readDaemonRequestAuthToken(request: object): string | undefined {
  return authTokenByRequest.get(request);
}
