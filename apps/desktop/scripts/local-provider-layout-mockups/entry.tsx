// Layout mockups for the Local Provider model table. The table is the app's
// usage table (header band emphasized, plain body), inside the real
// Extensions dialog with its section, select and action components.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChevronDown, ChevronRight, Cpu, RotateCcw, Square, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionFacts,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionSection,
} from '../../src/renderer/settings/extension-detail';
import { OpenSelect } from '../../src/renderer/OpenSelect';
import { initUiLanguage, setUiLanguagePreference } from '../../src/renderer/i18n';
import '../../src/renderer/bootstrap-styles';
import '../../src/renderer/settings/settings.css';
import '../../src/renderer/desktop/31-extensions.css';
import '../../src/renderer/desktop/28-usage-explorer.css';
import './mockups.css';
import { settleFrames } from '../probe-settle';

type Tone = 'ok' | 'warn' | 'danger' | 'muted';
const noop = () => {};

const CONTEXT_OPTIONS = [
  { value: '16384', label: '16K' },
  { value: '32768', label: '32K · 권장' },
  { value: '65536', label: '64K' },
  { value: '131072', label: '128K' },
];

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="extensions-item-status extensions-dialog-title-status" data-tone={tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function ContextSelect() {
  return (
    <OpenSelect
      className="extensions-select"
      ariaLabel="컨텍스트 크기"
      value="32768"
      displayValue="32K"
      options={CONTEXT_OPTIONS}
      onChange={noop}
    />
  );
}

function IdleSelect() {
  return (
    <OpenSelect
      className="extensions-select"
      ariaLabel="유휴 시 자동 언로드"
      value="3600"
      options={[{ value: '3600', label: '1시간 후' }]}
      onChange={noop}
    />
  );
}

function IconAction({ label, danger, children }: { label: string; danger?: boolean; children: ReactNode }) {
  return (
    <span className="lpm-icon" data-tooltip={label}>
      <ExtensionAction ariaLabel={label} danger={danger}>
        {children}
      </ExtensionAction>
    </span>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="usage-table-shell">
      <table className="usage-table">
        <thead>
          <tr>
            {head.map((label, index) => (
              <th key={index} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function ModelCell({ name, meta, error }: { name: string; meta?: string; error?: string }) {
  return (
    <td className="usage-provider-cell">
      <b>{name}</b>
      {error ? <span className="lpm-error">{error}</span> : <span>{meta}</span>}
    </td>
  );
}

function Progress({ percent }: { percent: number }) {
  return (
    <>
      <Pill tone="muted">설치 중 {percent}%</Pill>
      <div className="lpm-bar">
        <span style={{ width: `${percent}%` }} />
      </div>
    </>
  );
}

function Settings() {
  return (
    <ExtensionSection title="설정">
      <ExtensionItemList>
        <ExtensionItemRow
          title="유휴 시 자동 언로드"
          description="처리 중이거나 대기 중인 요청이 있으면 모델을 유지합니다."
          control={<IdleSelect />}
        />
      </ExtensionItemList>
    </ExtensionSection>
  );
}

function Info() {
  return (
    <ExtensionSection title="정보" collapsible>
      <ExtensionFacts
        facts={[
          ['엔진', 'llama.cpp b10621'],
          ['GPU', 'NVIDIA GeForce RTX 3090 · 24 GB'],
        ]}
      />
    </ExtensionSection>
  );
}

// C1 — header band, text actions.
function C1() {
  return (
    <>
      <ExtensionSection title="모델" count={3} description="에이전트 작업에는 컨텍스트 32K 이상을 권장합니다.">
        <Table head={['모델', '상태', '크기', '컨텍스트', '']}>
          <tr>
            <ModelCell name="Qwen3.8 27B" meta="Q4_K_M" />
            <td>
              <Pill tone="ok">실행 중</Pill>
            </td>
            <td className="lpm-num">19.0 GB</td>
            <td>
              <ContextSelect />
            </td>
            <td>
              <ExtensionAction danger>삭제</ExtensionAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Gemma 4 12B" meta="약 2분 남음" />
            <td>
              <Progress percent={42} />
            </td>
            <td className="lpm-num">3.1 / 7.3 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <ExtensionAction>중지</ExtensionAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Llama 4 8B" error="연결 끊김" />
            <td>
              <Pill tone="danger">설치 실패</Pill>
            </td>
            <td className="lpm-num">1.2 / 5.7 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <span className="lpm-actions">
                <ExtensionAction>재시도</ExtensionAction>
                <ExtensionAction danger>정리</ExtensionAction>
              </span>
            </td>
          </tr>
        </Table>
      </ExtensionSection>
      <Settings />
      <Info />
    </>
  );
}

// C2 — fewer columns: size and VRAM under the name, icon-only actions.
function C2() {
  return (
    <>
      <ExtensionSection title="모델" count={3}>
        <Table head={['모델', '상태', '컨텍스트', '']}>
          <tr>
            <ModelCell name="Qwen3.8 27B Q4_K_M" meta="19.0 GB · VRAM ~23.6 GB" />
            <td>
              <Pill tone="ok">실행 중</Pill>
            </td>
            <td>
              <ContextSelect />
            </td>
            <td>
              <IconAction label="삭제" danger>
                <Trash2 aria-hidden="true" />
              </IconAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Gemma 4 12B Q4_K_M" meta="3.1 / 7.3 GB · 약 2분 남음" />
            <td>
              <Progress percent={42} />
            </td>
            <td className="lpm-num">32K</td>
            <td>
              <IconAction label="다운로드 중지">
                <Square aria-hidden="true" />
              </IconAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Llama 4 8B Q5_K_M" error="연결 끊김 · 받은 1.2 GB 유지" />
            <td>
              <Pill tone="danger">설치 실패</Pill>
            </td>
            <td className="lpm-num">32K</td>
            <td>
              <span className="lpm-actions">
                <IconAction label="재시도">
                  <RotateCcw aria-hidden="true" />
                </IconAction>
                <IconAction label="정리" danger>
                  <X aria-hidden="true" />
                </IconAction>
              </span>
            </td>
          </tr>
        </Table>
      </ExtensionSection>
      <Settings />
      <Info />
    </>
  );
}

// C3 — read-only rows; the open row shows its context, unload and delete.
function C3() {
  return (
    <>
      <ExtensionSection title="모델" count={3}>
        <Table head={['모델', '상태', '크기', '컨텍스트', '']}>
          <tr className="lpm-open">
            <td className="usage-provider-cell">
              <span className="lpm-name">
                <ChevronDown className="lpm-chevron" aria-hidden="true" />
                <b>Qwen3.8 27B</b>
              </span>
              <span className="lpm-indent">Q4_K_M</span>
            </td>
            <td>
              <Pill tone="ok">실행 중</Pill>
            </td>
            <td className="lpm-num">19.0 GB</td>
            <td className="lpm-num">32K</td>
            <td />
          </tr>
          <tr>
            <td colSpan={5}>
              <div className="lpm-detail">
                <div className="lpm-detail-row">
                  <span>컨텍스트 크기</span>
                  <ContextSelect />
                  <span className="lpm-hint">에이전트 작업에는 32K 이상 권장</span>
                </div>
                <div className="lpm-detail-row">
                  <span>VRAM</span>
                  <span className="lpm-num">약 23.6 GB</span>
                </div>
                <div className="lpm-detail-row">
                  <span />
                  <span className="lpm-actions">
                    <ExtensionAction>모델 내리기</ExtensionAction>
                    <ExtensionAction danger>삭제…</ExtensionAction>
                  </span>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td className="usage-provider-cell">
              <span className="lpm-name">
                <ChevronRight className="lpm-chevron" aria-hidden="true" />
                <b>Gemma 4 12B</b>
              </span>
              <span className="lpm-indent">약 2분 남음</span>
            </td>
            <td>
              <Progress percent={42} />
            </td>
            <td className="lpm-num">3.1 / 7.3 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <ExtensionAction>중지</ExtensionAction>
            </td>
          </tr>
          <tr>
            <td className="usage-provider-cell">
              <span className="lpm-name">
                <ChevronRight className="lpm-chevron" aria-hidden="true" />
                <b>Llama 4 8B</b>
              </span>
              <span className="lpm-indent lpm-error">연결 끊김</span>
            </td>
            <td>
              <Pill tone="danger">설치 실패</Pill>
            </td>
            <td className="lpm-num">1.2 / 5.7 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <span className="lpm-actions">
                <ExtensionAction>재시도</ExtensionAction>
                <ExtensionAction danger>정리</ExtensionAction>
              </span>
            </td>
          </tr>
        </Table>
      </ExtensionSection>
      <Settings />
      <Info />
    </>
  );
}

// C4 — a state summary in the section head and the idle-unload setting as
// the table's footer band, so the dialog is one table plus info.
function C4() {
  return (
    <>
      <ExtensionSection
        title="모델"
        count={3}
        action={
          <span className="lpm-summary">
            <Pill tone="ok">실행 중 1</Pill>
            <Pill tone="muted">설치 중 1</Pill>
            <Pill tone="danger">실패 1</Pill>
          </span>
        }
      >
        <Table head={['모델', '상태', 'VRAM', '컨텍스트', '']}>
          <tr>
            <ModelCell name="Qwen3.8 27B" meta="Q4_K_M · 19.0 GB" />
            <td>
              <Pill tone="ok">실행 중</Pill>
            </td>
            <td className="lpm-num">23.6 GB</td>
            <td>
              <ContextSelect />
            </td>
            <td>
              <IconAction label="삭제" danger>
                <Trash2 aria-hidden="true" />
              </IconAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Gemma 4 12B" meta="Q4_K_M · 3.1 / 7.3 GB" />
            <td>
              <Progress percent={42} />
            </td>
            <td className="lpm-num">9.8 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <IconAction label="다운로드 중지">
                <Square aria-hidden="true" />
              </IconAction>
            </td>
          </tr>
          <tr>
            <ModelCell name="Llama 4 8B" error="연결 끊김" />
            <td>
              <Pill tone="danger">설치 실패</Pill>
            </td>
            <td className="lpm-num">7.1 GB</td>
            <td className="lpm-num">32K</td>
            <td>
              <span className="lpm-actions">
                <IconAction label="재시도">
                  <RotateCcw aria-hidden="true" />
                </IconAction>
                <IconAction label="정리" danger>
                  <X aria-hidden="true" />
                </IconAction>
              </span>
            </td>
          </tr>
          <tr className="lpm-footer">
            <td colSpan={3}>유휴 시 자동 언로드 · 요청이 남아 있으면 유지</td>
            <td colSpan={2}>
              <IdleSelect />
            </td>
          </tr>
        </Table>
      </ExtensionSection>
      <Info />
    </>
  );
}

const VARIANTS: Record<string, () => ReactNode> = { C1, C2, C3, C4 };
const root = createRoot(document.getElementById('root')!);
(window as any).mixdogDesktop = { async setTitleBarDim() {}, rendererDiagnostic() {} };
(window as any).layoutMockups = {
  variants: Object.keys(VARIANTS),
  async render(variant: string, theme: string) {
    setUiLanguagePreference('ko');
    await initUiLanguage();
    document.documentElement.dataset.mixdogTheme = theme;
    document.documentElement.style.setProperty('--mx-device-scale', '1');
    const Body = VARIANTS[variant];
    flushSync(() =>
      root.render(
        <div className="app-shell" key={`${variant}-${theme}`}>
          <ExtensionDetailDialog
            title="로컬 모델 사용"
            icon={<Cpu size={16} />}
            tagline="AI 모델을 다운로드하고 믹스독에서 직접 실행합니다."
            enabled
            onToggle={noop}
            onClose={noop}
          >
            <Body />
          </ExtensionDetailDialog>
        </div>
      )
    );
    await settleFrames();
  },
  settle: settleFrames,
};
