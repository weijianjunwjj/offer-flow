import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmApi } from './llmApi';

function streamResponse(lines: string[]) {
  const encoder = new TextEncoder();
  const read = vi.fn();
  for (const line of lines) {
    read.mockResolvedValueOnce({ done: false, value: encoder.encode(`${line}\n`) });
  }
  read.mockResolvedValueOnce({ done: true, value: undefined });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  const reader = { read, cancel, releaseLock };
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response,
    reader,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('legacy SSE client 生命周期', () => {
  it('传递 AbortSignal，并在正常结束后 cancel/release reader', async () => {
    const { response, reader } = streamResponse([
      'data: {"type":"chunk","content":"A"}',
      'data: {"type":"done","rawText":"A","parseStatus":"success"}',
    ]);
    const fetchSpy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();
    const stream = llmApi.analyzeJobStream({ jobId: 'A' }, { signal: controller.signal });
    const chunks: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      if (next.value.content) chunks.push(next.value.content);
      next = await stream.next();
    }
    expect(chunks).toEqual(['A']);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('消费者提前 return 也清理 reader', async () => {
    const { response, reader } = streamResponse(['data: {"type":"chunk","content":"A"}']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const stream = llmApi.analyzeJobStream({ jobId: 'A' });
    await stream.next();
    await stream.return({
      rawText: '', parsed: null, parseStatus: 'error', error: '', model: '', createdAt: 0,
    });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});
