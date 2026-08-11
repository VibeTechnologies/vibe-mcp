export function relayChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.VIBE_MCP_HTTP_BEARER_TOKEN;
  return env;
}
