// The opencode plugin channel addresses and session mapping utilities.

export function opencodePluginSocketPath(stateDir: string): string {
  return stateDir + "/opencode-plugin.sock";
}
