export const API_BASE = 'http://127.0.0.1:17365';

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface ReadOptions {
  signal?: AbortSignal;
}

export async function apiGet<T>(path: string, options: ReadOptions = {}): Promise<T> {
  return apiRequest<T>(path, { signal: options.signal });
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), init);
  if (!response.ok) {
    const responseText = await response.text();
    let body: unknown;
    try {
      body = responseText === '' ? undefined : JSON.parse(responseText);
    } catch {
      body = responseText;
    }
    const message = (
      body !== null
      && typeof body === 'object'
      && 'message' in body
      && typeof body.message === 'string'
    ) ? body.message : `HTTP ${response.status}`;
    throw new ApiError(message, response.status, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
