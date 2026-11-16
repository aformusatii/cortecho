import { expect, it } from 'vitest';
import { openDatabase } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createTurnsRepository } from './turns.repository.ts';

it('round trips citations and supports ordinary turns with no search metadata', () => {
  const { db, sqlite } = openDatabase(':memory:');
  try {
    runMigrations(db);
    const turns = createTurnsRepository(db);
    const ordinary = turns.insert({
      source: 'ask',
      outcome: 'answered',
      startedAt: new Date(),
      reply: 'Hi.',
    });
    expect(ordinary.displayText).toBeUndefined();
    const display = {
      displayText: 'Fact. [1]',
      citations: [{ start: 6, end: 9, url: 'https://example.com', title: 'Source' }],
    };
    turns.insert({ source: 'ask', outcome: 'answered', startedAt: new Date(), reply: 'Fact.', ...display });
    expect(turns.latest(1)[0]).toMatchObject(display);
  } finally {
    sqlite.close();
  }
});
