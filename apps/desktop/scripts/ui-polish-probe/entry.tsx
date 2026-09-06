import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Folder, Workflow, Clock, Plus, Settings, MessageSquare } from "lucide-react";
import { SessionSidebar } from "../../src/renderer/session-sidebar";
import { RowOverflowMenu } from "../../src/renderer/RowOverflowMenu";
import { DialogFrame, MenuList } from "../../src/renderer/ui/primitives";
import "../../src/renderer/bootstrap-styles";

const root = createRoot(document.getElementById("root")!);
const noop = () => {};
const asyncNoop = async () => {};
const now = Date.now();
const sessions = Array.from({ length: 12 }, (_, index) => ({
  id: `polish-${index}`,
  title: index === 0 ? "팝업과 사이드탭 UI 정돈" : `프로젝트 검토 ${index} · 긴 제목도 목록 안에서 정렬됩니다`,
  preview: "선택 · 상태 · 작업 목록",
  updatedAt: now - index * 60_000,
  activityAt: now - index * 60_000,
  messageCount: 2,
  cwd: "C:\\Project\\mixdog",
  classification: "task" as const,
  projectPath: "C:\\Project\\mixdog",
  working: false,
}));
const resources = [
  ["Mixdog", "C:\\Project\\mixdog · 데스크톱 앱"],
  ["ProjectAA", "Unity · 전투 시뮬레이션"],
  ["Gamerscroll", "게임과 기술을 다루는 블로그"],
  ["이름이 긴 프로젝트의 정렬과 말줄임 확인", "C:\\Project\\long-project-name\\source\\components"],
];
const items = [
  { id: "open", label: "프로젝트 열기", onSelect: noop },
  { id: "rename", label: "이름 변경", onSelect: noop },
  { id: "disabled", label: "사용할 수 없는 작업", disabled: true },
  { id: "more", label: "추가 작업", children: Array.from({ length: 12 }, (_, index) => ({
    id: `extra-${index}`, label: `추가 작업 ${index + 1}`, onSelect: noop,
  })) },
  { id: "delete", label: "목록에서 삭제", danger: true, separatorBefore: true, onSelect: noop },
];

function ResourceRows() {
  return <div className="schedules-page projects-pane">
    <div className="schedules-search"><input aria-label="프로젝트 검색" placeholder="프로젝트 검색" /></div>
    <div className="schedules-list">
      {resources.map(([name, description], index) => <div
        key={name} tabIndex={0} role="button"
        className={`schedules-row projects-row${index === 0 ? " selected" : ""}`}>
        <Folder className="projects-row-icon" size={16} />
        <span className="schedules-row-copy"><b>{name}</b><small>{description}</small></span>
        <RowOverflowMenu label={`${name} 작업`} items={items} width={220} />
      </div>)}
    </div>
  </div>;
}

function Rail() {
  return <nav className="activity-rail">
    <button aria-label="새 작업"><Plus /></button>
    <nav className="sidebar-primary-nav workbench-side-icon-bar is-vertical">
      <button aria-label="세션"><MessageSquare /></button>
      <button aria-label="프로젝트" className="active"><Folder /></button>
      <button aria-label="워크플로우"><Workflow /></button>
      <button aria-label="스케줄"><Clock /></button>
    </nav>
    <div className="activity-rail-spacer" />
    <button aria-label="설정"><Settings /></button>
  </nav>;
}

function Scene({ view, mobile }: { view: string; mobile: boolean }) {
  const sidebar = <>
    <Rail />
    <SessionSidebar open sessions={sessions} sessionsReady
      panelActive={view !== "sessions"} panelTitle="프로젝트"
      selection={{ kind: "new" }} onNewTask={noop} onResumeSession={noop}
      onRenameSession={asyncNoop} onArchiveSession={asyncNoop} onDeleteSession={asyncNoop}>
      <ResourceRows />
    </SessionSidebar>
  </>;
  return <div className="app-shell">
    <div style={{ height: 35, flex: "0 0 35px", padding: "8px 16px", color: "var(--mx-text-muted)" }}>Mixdog</div>
    <div className="desktop-body">
      {mobile ? <div className="sidebar-drawer-frame" data-state="open" data-motion="instant">{sidebar}</div> : sidebar}
      <main style={{ flex: 1, minWidth: 0, padding: 32, background: "var(--mx-workspace-sheet)" }}>
        <h2 style={{ fontSize: 20, fontWeight: 500 }}>새 작업</h2>
        <p style={{ color: "var(--mx-text-muted)" }}>무엇을 도와드릴까요?</p>
      </main>
    </div>
    {view === "dialog" && <DialogFrame title="프로젝트 설정" onClose={noop}
      footer={<><button>취소</button><button className="primary">저장</button></>}>
      <div style={{ display: "grid", gap: 16 }}>
        <label className="schedules-field"><span>이름</span><input defaultValue="Mixdog" /></label>
        <label className="schedules-field"><span>프로젝트 경로</span><input defaultValue="C:\\Project\\mixdog" /></label>
        <label className="schedules-field"><span>설명</span><input defaultValue="팝업과 사이드탭의 공통 시각 규칙" /></label>
        <p style={{ margin: 0, color: "var(--mx-text-muted)" }}>변경 사항은 이 프로젝트에만 적용됩니다. 긴 내용은 본문에서 스크롤하고 버튼은 그대로 유지합니다.</p>
        {Array.from({ length: 8 }, (_, index) => <label key={index} className="schedules-field">
          <span>추가 설정 {index + 1}</span><input defaultValue="작은 창에서도 정렬 유지" />
        </label>)}
      </div>
    </DialogFrame>}
    {view === "select" && <MenuList label="모델 선택">
      <button className="mx-menu-item" aria-selected="true"><span>GPT-6-Astra</span></button>
      <button className="mx-menu-item"><span>GPT-5.6-Sol</span></button>
      <button className="mx-menu-item" disabled><span>사용할 수 없는 모델</span></button>
    </MenuList>}
  </div>;
}

async function settle() {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Hidden windows can suspend animation timelines. Capture the settled
  // production appearance, not an arbitrary partly transparent entry frame.
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
  }
}
(window as any).polishProbe = {
  async render(view: string, theme: string, mobile = false) {
    document.documentElement.dataset.mixdogTheme = theme;
    document.documentElement.toggleAttribute("data-mixdog-mobile-tabs", mobile);
    // This fixture uses a logical-pixel viewport, as current mobile boot does.
    document.documentElement.style.setProperty("--mx-device-scale", "1");
    flushSync(() => root.render(<Scene key={`${view}-${theme}-${mobile}`} view={view} mobile={mobile} />));
    if (view === "select") Object.assign(document.querySelector<HTMLElement>(".mx-menu")!.style, {
      top: "64px", right: "20px", width: "240px",
    });
    await settle();
  },
  settle,
};
