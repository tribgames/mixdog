// Production loads the desktop skin before the lazy Extensions stylesheet.
import "../../src/renderer/bootstrap-styles";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ExtensionsPane } from "../../src/renderer/ExtensionsView";
import { SchedulesPane } from "../../src/renderer/SchedulesView";
import { WebhooksPane } from "../../src/renderer/WebhooksView";
import { WorkflowsPane } from "../../src/renderer/WorkflowsView";
import { ProjectsPane } from "../../src/renderer/ProjectsView";
import { SessionSidebar } from "../../src/renderer/session-sidebar";
import { SourceControlViewControls } from "../../src/renderer/SourceControlViewControls";
import { SECTION_READS } from "../../src/renderer/settings/capability-data";
import { adoptSidebarReferenceHost, resetSidebarReferenceCache, updateSidebarReference } from "../../src/renderer/sidebar-reference-cache";
import { initUiLanguage, setUiLanguagePreference } from "../../src/renderer/i18n";

const root = createRoot(document.getElementById("root")!);
const noop = () => {};
const asyncNoop = async () => {};
const projectPath = "C:\\Project\\mixdog";
const projects = [
  { path: projectPath, name: "mixdog", alias: null },
  { path: "C:\\Project\\long-project-name", name: "long-project-name", alias: "긴 프로젝트 이름과 레이아웃 검증" },
];
const instructions = "# Instructions\n\n" + Array.from({ length: 18 }, (_, i) =>
  `## Section ${i + 1}\n\nKeep existing behavior, report errors, and validate the result. 긴 내용도 편집 영역에서 읽을 수 있어야 합니다.\n`).join("\n");
const skills = [
  { name: "mixdog-refs", description: "Consult reference material and govern how borrowed code is handled.", whenToUse: '"refs 참고", "reference check"; when reading or adapting reference code.', editable: true },
  { name: "a-very-long-skill-name-for-layout-checking", description: "이름과 설명이 길어도 다른 사이드 탭과 같은 정렬과 글자 크기를 유지합니다. 설명은 최대 두 줄로 표시합니다.", editable: true },
  { name: "bundled-skill", description: "Included instructions", owner: { kind: "plugin", id: "example-plugin" } },
];
const servers = [
  { name: "UnityMCP", enabled: true, status: "connected", connected: true, config: { type: "stdio", command: "uvx", args: ["--from", "unity-mcp"], env: { PROJECT: projectPath } } },
  { name: "remote-http", enabled: true, status: "connected", connected: true, config: { type: "http", url: "https://example.test/mcp", headers: { "X-Project": "mixdog" } } },
  { name: "plugin-example", enabled: true, source: "plugin", connected: true, config: { type: "stdio", command: "node" } },
];
const workflows = [{ id: "custom", name: "Custom workflow", description: "일관된 규칙으로 작업하는 워크플로우", source: "user", body: instructions }];
const channelSetup = {
  schedules: [{ name: "Daily review", enabled: true, cron: "0 9 * * *", prompt: "Review the project changes.", cwd: projectPath }],
  webhooks: [{ name: "Incoming review", enabled: true, parser: "json", description: "수신 요청 처리", prompt: "Review {{body}}", cwd: projectPath }],
  webhook: { publicUrl: "https://example.test" },
};
const data: Record<string, unknown> = {
  toolModules: Object.fromEntries(["git", "memory", "office", "localProvider"].map(id => [id, {
    installed: true, enabled: true,
    ...(id === "localProvider" ? { available: true, running: false, models: [], installations: [], runtime: { installed: true, version: "b-test" }, gpu: { name: "RTX 3090" } } : {}),
  }])),
  voice: { installed: true, enabled: true },
  plugins: { plugins: [{ id: "example-plugin", name: "Example plugin", enabled: true, description: "플러그인과 포함된 스킬·MCP의 설정을 관리합니다.", version: "1.0.0", sourceType: "local", root: "C:\\Project\\long-plugin-directory\\example-plugin", mcpServerName: "plugin-example", mcpScript: "mcp.mjs", mcpEnabled: true }] },
  skills: { cwd: projectPath, skills },
  mcp: { servers },
  disabledSkills: { disabled: [] },
};
let api: any;
let calls: Array<{ capability: string; args: unknown[] }> = [];
function makeHost() {
  const reads = new Map(SECTION_READS.map(([key, capability]) => [capability as string, data[key] ?? {}]));
  const value = (capability: string, args: unknown[] = []) => {
    if (reads.has(capability)) return reads.get(capability);
    if (capability === "skillContent") return { content: instructions };
    if (capability === "getMcpServerConfig") return servers.find(server => server.name === args[0]);
    if (capability === "getWorkflowPack") return workflows[0];
    if (capability === "getChannelSetup") return channelSetup;
    if (capability === "listWorkflows") return workflows;
    if (capability === "listAgents" || capability === "listWebSearchModels") return [];
    return {};
  };
  return {
    setTitleBarDimmed: noop, rendererDiagnostic: noop, perfLog: noop,
    readSettings: async () => ({ browserControl: true, computerControl: true, browserInstalled: true, computerInstalled: true }),
    readCapabilities: async (requests: any[]) => requests.map(request => ({ ok: true, value: value(request.capability, request.args) })),
    invokeCapability: async (request: any) => { calls.push(request); return { value: value(request.capability, request.args) }; },
    listProviderModels: async () => [], listProjects: async () => projects,
    getSnapshot: async () => null, getUpdaterState: async () => ({ status: "disabled" }),
    gitCliStatus: async () => ({ installed: true, version: "2.50.0" }),
    libreOfficeStatus: async () => ({ installed: true, version: "25.2" }),
    githubCliStatus: async () => ({ installed: true, authenticated: true, login: "ExampleOwner", version: "2.81.0" }),
    githubCliAccount: async () => ({ login: "ExampleOwner", name: "Example Owner", email: "123456+ExampleOwner@users.noreply.github.com" }),
    gitGlobalConfig: async () => ({ name: "Example Owner", email: "owner@example.test" }),
    computerReadAuthorization: async () => ({ policy: null, externallyRestricted: false }),
    computerUpdateAuthorization: async () => ({ policy: null }),
    computerAuthorizationWindows: async () => [{ id: "window-1", pid: 123, title: "긴 창 제목도 안전하게 표시합니다", app: "Example editor" }],
  };
}
function seedReferences() {
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  for (const [key, value] of Object.entries({
    channelSetup, workflows, projects, agents: [], webSearchRoute: {}, webSearchModels: [], providerSetup: {}, quickProviderModels: [],
  })) updateSidebarReference(key as any, value as any);
}
function ExtensionPanel({ section: initialSection }: { section: "plugins" | "skills" }) {
  const [section, setSection] = useState(initialSection);
  return <ExtensionsPane active section={section} onSectionChange={setSection} />;
}
function ProjectPanel() {
  return <ProjectsPane active projects={projects} selectedProjectPath={projectPath}
    onChooseFolder={async () => projectPath} onCreateProject={asyncNoop}
    onRename={noop} onRemove={noop} instructionsSupported
    onReadInstructions={async () => instructions} onSaveInstructions={asyncNoop} />;
}
function PanelShell({ title, children, width = 260 }: React.PropsWithChildren<{ title: string; width?: number }>) {
  return <div className="workbench-side-section-body" data-probe-panel={title}
    style={{ width, minWidth: 0, height: "100%", flex: `0 0 ${width}px`, overflow: "hidden",
      "--workbench-side-panel-width": `${width}px` } as React.CSSProperties}>
    <SessionSidebar open panelActive panelTitle={title} sessions={[]} sessionsReady
      selection={{ kind: "new" }} onNewTask={noop} onResumeSession={noop}
      onRenameSession={asyncNoop} onArchiveSession={asyncNoop} onDeleteSession={asyncNoop}>
      {children}
    </SessionSidebar>
  </div>;
}
function Scene({ view, railWidth }: { view: string; railWidth: number }) {
  let panel: React.ReactNode;
  const skillsView = ["skills", "skill", "mcp-stdio", "mcp-http", "create-skill"].includes(view);
  if (view === "schedule") panel = <SchedulesPane api={api} active />;
  else if (view === "webhook") panel = <WebhooksPane api={api} active />;
  else if (view === "workflow") panel = <WorkflowsPane api={api} active />;
  else if (view === "project") panel = <ProjectPanel />;
  else panel = <ExtensionPanel section={skillsView ? "skills" : "plugins"} />;
  return <div className="app-shell">
    <div style={{ flex: "0 0 35px", height: 35 }} />
    <div className="desktop-body">
      {view === "comparison" ? <>
        <PanelShell title="Extensions" width={railWidth}><ExtensionPanel section="skills" /></PanelShell>
        <PanelShell title="Schedules" width={railWidth}><SchedulesPane api={api} active /></PanelShell>
        <PanelShell title="Webhooks" width={railWidth}><WebhooksPane api={api} active /></PanelShell>
        <PanelShell title="Projects" width={railWidth}><ProjectPanel /></PanelShell>
        <div className="utility-dock" data-probe-panel="Source Control" style={{ flex: 1, minWidth: 0 }}>
          <SourceControlViewControls fileCount={3} fileFilter="" historyQuery="" view="changes"
            onFileFilterChange={noop} onHistoryQueryChange={noop} onViewChange={noop} />
        </div>
      </> : <>
        <PanelShell title="Extensions" width={railWidth}>{panel}</PanelShell>
        <main style={{ flex: 1, minWidth: 0, background: "var(--mx-workspace-sheet)" }} />
      </>}
    </div>
  </div>;
}
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 80));
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
  }
}
function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing fixture target: ${selector}`);
  element.click();
}
(window as any).extensionsProbe = {
  async render(view: string, theme: string, language: "ko" | "en", mobile: boolean, railWidth: number) {
    flushSync(() => root.render(null));
    calls = [];
    api = makeHost();
    window.mixdogDesktop = api;
    seedReferences();
    document.documentElement.dataset.mixdogTheme = theme;
    document.documentElement.toggleAttribute("data-mixdog-mobile-tabs", mobile);
    document.documentElement.style.setProperty("--mx-device-scale", "1");
    setUiLanguagePreference(language);
    await initUiLanguage();
    flushSync(() => root.render(<Scene key={`${view}-${theme}-${language}`} view={view} railWidth={railWidth} />));
    await settle();
    const selectors: Record<string, string> = {
      git: '[data-built-in-feature="git"]',
      browser: '[data-built-in-feature="browser"]', computer: '[data-built-in-feature="computer"]',
      memory: '[data-built-in-feature="memory"]', office: '[data-built-in-feature="office"]',
      voice: '[data-built-in-feature="voice"]', localProvider: '[data-built-in-feature="localProvider"]',
      plugin: '[data-extension-row="Example plugin"]', skill: '[data-extension-row="mixdog-refs"]',
      "mcp-stdio": '[data-extension-row="UnityMCP"]', "mcp-http": '[data-extension-row="remote-http"]',
      schedule: ".schedules-row", webhook: ".schedules-row", workflow: ".workflows-packs .schedules-row",
      project: ".projects-list:not(.projects-common-instructions) .projects-row",
      "create-skill": ".session-panel-header .session-panel-action",
      "install-plugin": ".session-panel-header .session-panel-action",
    };
    if (selectors[view]) {
      click(selectors[view]);
      await settle();
      if (view === "create-skill") { click('[data-extension-create-kind="skill"]'); await settle(); }
    }
  },
  settle,
  calls: () => calls,
};
