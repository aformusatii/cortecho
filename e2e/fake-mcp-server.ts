import { startFakeMcpServer } from '../apps/api/src/mcp/fake-mcp-server.ts';

/** Longer than the 500-character cap, so the Prompt tab has a "cut" note to show. */
const LONG_INSTRUCTIONS = (
  'Harness models. Use start_session with a model from this list: ' +
  'opencode/deepseek-chat, claude/haiku, claude/sonnet. Default: claude/sonnet. '
)
  .repeat(20)
  .slice(0, 1200);

// Two test servers for the browser suite: one requires OAuth (the full
// sign-in flow), one accepts anyone (the plain connector flow). They stay up
// until Playwright stops this process.
await startFakeMcpServer({ port: 26200, requireAuth: true, label: 'e2e-auth' });
await startFakeMcpServer({
  port: 26201,
  requireAuth: false,
  label: 'e2e-open',
  instructions: LONG_INSTRUCTIONS,
});
console.log('fake MCP servers on 127.0.0.1:26200 (OAuth) and :26201 (open)');
setInterval(() => {}, 1 << 30);
