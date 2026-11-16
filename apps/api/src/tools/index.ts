import type { Config } from '../config.ts';
import { echoTestTool } from './plugins/echo-test.ts';
import { homeAssistantServiceTool, homeAssistantStateTool } from './plugins/home-assistant.ts';
import { httpRequestTool } from './plugins/http-request.ts';
import { runScriptTool } from './plugins/run-script.ts';
import { ToolRegistry } from './registry.ts';

/**
 * Every tool the agent knows. A new action = one file in plugins/ plus one
 * `.register(...)` line here. Plugins return null when their config is
 * missing, and register(null) is a no-op.
 *
 * There is no "current time" tool: the agent gets the date and time with
 * every request (pipeline/agent.ts), which saves a model round trip.
 */
export function buildToolRegistry(config: Config): ToolRegistry {
  const { tools } = config;
  return new ToolRegistry({ allowDestructive: tools.allowDestructive, timeoutMs: tools.timeoutMs })
    .register(tools.enableEchoTool ? echoTestTool() : null)
    .register(httpRequestTool(tools.httpEndpoints))
    .register(homeAssistantStateTool(tools.homeAssistant))
    .register(homeAssistantServiceTool(tools.homeAssistant))
    .register(runScriptTool(tools.shellScripts));
}
