export const API_BASE = import.meta.env.VITE_OFFERFLOW_API_BASE || '/api';

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

export class ApiNetworkError extends Error {
  constructor(readonly originalError: unknown) {
    super('Network request failed');
  }
}

export interface ReadOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface SendOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function apiGet<T>(path: string, options: ReadOptions = {}): Promise<T> {
  return apiRequest<T>(path, {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    signal: options.signal,
  });
}

export async function apiSend<T>(
  path: string,
  method: string,
  body?: unknown,
  options: SendOptions = {},
): Promise<T> {
  return apiRequest<T>(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildApiUrl(path), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiNetworkError(error);
  }
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
