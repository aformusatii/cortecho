import { describe, expect, it, vi } from 'vitest';
import { transcribeReply } from './transcribe.ts';

/** A small WAV with Cortecho's streamed placeholder sizes. */
function streamedWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0xffffffff - 36, 40);
  return Buffer.concat([header, pcm]);
}

/** Counts how many times each body reader is called on a Response. */
function counted(response: Response): { response: Response; reads: { text: number; json: number } } {
  const reads = { text: 0, json: 0 };
  const text = response.text.bind(response);
  const json = response.json.bind(response);
  Object.defineProperties(response, {
    text: {
      value: () => {
        reads.text += 1;
        return text();
      },
    },
    json: {
      value: () => {
        reads.json += 1;
        return json();
      },
    },
  });
  return { response, reads };
}

function mockFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe('transcribeReply', () => {
  it('fixes the streamed header, sends a file, and reads the body once', async () => {
    const { response, reads } = counted(Response.json({ text: "It's 7:30 in the morning." }));
    const fetchImpl = mockFetch(response);

    const text = await transcribeReply(streamedWav(Buffer.alloc(200, 1)), {
      gatewayUrl: 'http://gateway:8080',
      fetchImpl,
    });
    expect(text).toBe("It's 7:30 in the morning.");
    // One read: reading text() and then json() is the "Body is unusable" bug.
    expect(reads).toEqual({ text: 1, json: 0 });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('http://gateway:8080/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(body.get('model')).toBe('gpt-4o-mini-transcribe');
    const file = body.get('file') as File;
    expect(file.name).toBe('reply.wav');
    expect(file.type).toBe('audio/wav');
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
  });

  it('surfaces a 400 body once, without reading it twice', async () => {
    const { response, reads } = counted(
      new Response('{"error":{"code":"unsupported_format"}}', { status: 400 }),
    );
    const fetchImpl = mockFetch(response);

    await expect(
      transcribeReply(streamedWav(Buffer.alloc(20, 1)), {
        gatewayUrl: 'http://gateway:8080',
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 400.*unsupported_format/);
    expect(reads).toEqual({ text: 1, json: 0 });
  });
});
