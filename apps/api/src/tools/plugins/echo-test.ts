import type { Tool } from '../registry.ts';

/** A harmless tool for checking that function calling works end to end. */
export function echoTestTool(): Tool {
  return {
    name: 'echo_test',
    description:
      'Test tool: returns the given text unchanged. Use it only when the user asks to test the tools.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Any text.' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args) => ({ echoed: String(args.text ?? '') }),
  };
}
