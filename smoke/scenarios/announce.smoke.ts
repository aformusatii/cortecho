import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { useSmokeEcho } from '../harness/smoke-echo.ts';

// Announcements: POST /api/say to this Echo, then (tagged @audible) to all Echos.
describe('announcements', () => {
  const echo = useSmokeEcho();
  beforeAll(() => echo.setup());
  afterAll(() => echo.teardown());
  beforeEach(() => echo.newConversation());

  test('announces on this Echo', async () => {
    await echo.announce(`smoke test ${echo.tag} on the test Echo`);
  });

  // @audible: this one also plays on the real Echo in the house (spec O5).
  test('announces on every Echo', async () => {
    await echo.announce(`smoke test ${echo.tag} on all Echos`, { all: true });
  });
});
