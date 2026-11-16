import { describe, expect, it } from 'vitest';
import { answerWithCitations } from './search-answer.ts';

describe('search answer', () => {
  it('preserves display offsets and removes citations and URLs from speech', () => {
    const text = 'It is sunny. [source] Visit https://example.com';
    const reply = answerWithCitations(text, [
      { type: 'web_search_call' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [
              {
                type: 'url_citation',
                start_index: 13,
                end_index: 21,
                url: 'https://example.com',
                title: 'Weather',
              },
            ],
          },
        ],
      },
    ]);
    expect(reply.text).toBe('It is sunny. Visit');
    expect(reply.displayText).toBe(text);
    expect(reply.citations).toEqual([{ start: 13, end: 21, url: 'https://example.com', title: 'Weather' }]);
  });

  it('ignores unsafe URLs and invalid annotation ranges', () => {
    const reply = answerWithCitations('Hi.', [
      { type: 'web_search_call' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Hi.',
            annotations: [
              { type: 'url_citation', start_index: 0, end_index: 2, url: 'javascript:alert(1)' },
              { type: 'url_citation', start_index: -1, end_index: 2, url: 'https://example.com' },
            ],
          },
        ],
      },
    ]);
    expect(reply.citations).toEqual([]);
    expect(reply.text).toBe('Hi.');
  });

  it('leaves ordinary answers unchanged', () => {
    expect(answerWithCitations('Hello.', [])).toEqual({ text: 'Hello.' });
  });
});
