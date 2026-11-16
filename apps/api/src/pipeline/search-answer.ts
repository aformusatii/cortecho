import type { ReplyCitation, SearchDisplay } from '@cortecho/shared';
import type { ResponseItem } from './agent.ts';

/** Keep citation offsets tied to the original display text, not the speech copy. */
export function answerWithCitations(text: string, output: ResponseItem[]): SearchDisplay & { text: string } {
  let displayText = '';
  const citations: ReplyCitation[] = [];
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
      if (displayText) displayText += ' ';
      const offset = displayText.length;
      displayText += part.text;
      if (!Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (
          annotation.type !== 'url_citation' ||
          typeof annotation.url !== 'string' ||
          !/^https?:\/\//.test(annotation.url) ||
          !Number.isInteger(annotation.start_index) ||
          !Number.isInteger(annotation.end_index) ||
          annotation.start_index < 0 ||
          annotation.end_index < annotation.start_index ||
          annotation.end_index > part.text.length
        )
          continue;
        citations.push({
          start: offset + annotation.start_index,
          end: offset + annotation.end_index,
          url: annotation.url,
          title: typeof annotation.title === 'string' ? annotation.title : annotation.url,
        });
      }
    }
  }
  if (!citations.length && !output.some((item) => item.type === 'web_search_call')) return { text };
  citations.sort((a, b) => a.start - b.start || a.end - b.end);
  // Remove annotated citation spans before TTS, including provider-specific markers.
  let speech = '';
  let cursor = 0;
  for (const citation of citations) {
    if (citation.start < cursor) continue;
    speech += displayText.slice(cursor, citation.start);
    cursor = citation.end;
  }
  speech += displayText.slice(cursor);
  speech = (speech || text)
    .replace(/\uE200[^\uE201]*\uE201/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: speech, displayText: displayText || text, citations };
}
