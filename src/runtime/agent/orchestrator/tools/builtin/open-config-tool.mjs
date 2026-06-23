// open_config builtin tool.
//
// Lives in the always-on `builtin` module (not the gated `agent` module) so
// the config UI stays reachable even when modules.agent.enabled === false —
// otherwise a user who disabled the agent module would lose every way to open
// the settings UI (the old `bun launch.mjs` slash shell-out is gone).
//
// Launches the config UI through the resident MCP server. Because this server
// is a long-lived background process, its spawn of setup-server
// (windowsHide:true inside launch-core) creates NO console window — unlike the
// old `!bun launch.mjs` slash-command shell-out, which flashed a conhost. The
// launch-core import is lazy so its child_process/http deps stay off the hot
// builtin path until the tool is actually called.

export async function executeOpenConfigTool() {
    const { launchConfigUi, LaunchError } = await import(
        new URL('../../../../../setup/launch-core.mjs', import.meta.url).href
    );
    try {
        const url = await launchConfigUi();
        return `Config UI opened at ${url}`;
    } catch (err) {
        if (err instanceof LaunchError) return `Error: ${err.message.trim()}`;
        throw err;
    }
}
