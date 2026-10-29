import { type ReactNode, useId } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopModelOption } from '../shared/contract';
import { displayEffortLabel } from './auto-effort-store';
import { t } from './i18n';
import { ModelCatalog } from './model-catalog';
import { type RouteSpeed, routeSpeed } from './model-route-utils';
import { DAYBREAK_PARAMETER_ID, routeDaybreakBlue } from './provider-display';
import { useSurfaceActive } from './surface-activity';
import { useRouteFontWarmup } from './route-editor-effects';
import { useRoutePaneNavigation, useRouteSheet } from './route-editor-lifecycle';
import { useRoutePaneContent } from './route-editor-pane-content';
import {
  ROUTE_PANEL_PADDING,
  ROUTE_SHEET_ROW_HEIGHT,
  routePanelStyle,
  routeSheetRows,
  type RouteSheetPane,
} from './route-editor-logic';
import type { RouteAutoEffort, RouteSessionChoice } from './route-editor-panes';
import { RouteRow, RouteSheetRows, RouteTrigger, routeMorphStyle } from './route-editor-sheet';

// The rule between the model rows and the conversation's own settings.
const ROUTE_SEPARATOR_HEIGHT = 9;

export { routeSheetRows } from './route-editor-logic';

interface RouteEditorProps {
  /** Side the sheet opens toward: `above` for the composer's pill at the
   *  bottom of the screen, `below` for a dialog or settings field. */
  placement?: 'above' | 'below';
  /** A side-panel field (bot profile, Lead editor): the sheet drops down at
   *  the trigger's width and edges (above only without room below), every
   *  pane opens inside that same box, and the trigger never morphs — no
   *  flyout ever leaves the panel. Rows open on click, not hover. */
  dropdown?: boolean;
  /** The pill edge the sheet lines up with: `start` where the pill grows
   *  rightwards (it leads its row), `end` where it sits at its row's right
   *  end and grows leftwards. */
  align?: 'start' | 'end';
  /** Only the focused conversation's composer sets this; it is the single
   *  responder to the open-model-picker event. */
  answersModelPickerRequests?: boolean;
  models: DesktopModelOption[];
  provider: string;
  model: string;
  triggerModel: string;
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  fast: boolean;
  fastVisible: boolean;
  fastAvailable: boolean;
  contextVisible: boolean;
  contextPercent: number;
  contextDefaultPercent: number;
  contextTokens: number;
  /** Routed exact window (0 / absent = on a 10% stop or the default). */
  contextExactTokens?: number;
  contextMaxTokens?: number;
  contextDefaultTokens?: number;
  modelParameterOptions?: DesktopModelOption['modelParameterOptions'];
  modelParameters?: Record<string, string>;
  /** Setup-derived display names (custom providers), keyed by provider id. */
  providerNames?: Record<string, string>;
  catalogLoaded: boolean;
  catalogRefreshing: boolean;
  catalogError: string;
  providerSetupError: string;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  tooltip?: string;
  onSelectModel(option: DesktopModelOption): unknown;
  onChangeEffort(value: string): void;
  onChangeSpeed(speed: RouteSpeed): void;
  /** `tokens` is an exact window; omitted, the 10% stop applies and any exact window clears. */
  onChangeContext(percent: number, tokens?: number): void;
  onChangeModelParameter?(id: string, value: string): void;
  onOpenProviders?: () => void;
  /** The /model picker's "i": opens Settings → Model management. */
  onOpenModelManagement?: (provider?: string) => void;
  /** A /model row's menu saves a favourite / hidden change. */
  onSetModelPreference?: (option: DesktopModelOption, change: { hidden?: boolean; favorite?: boolean }) => unknown;
  /** Opening the catalog is also the user's retry gesture: the owner may
   *  re-request a catalog whose previous fetch failed. */
  onOpenModelPane?: () => void;
  autoEffort?: RouteAutoEffort;
  onChangeAutoEffort?(enabled: boolean): void;
  /** Opening the sheet lets the owner re-read the Auto effort switch. */
  onOpenSheet?: () => void;
  /** A conversation's workflow and delegation mode: rows below a separator. */
  sessionChoices?: RouteSessionChoice[];
}

/** What the sheet shows for the current route: its labels, its rows and the
 *  height they take. */
function routeSheetContent({
  provider,
  model,
  effort,
  effortOptions,
  fast,
  fastVisible,
  contextVisible,
  modelParameterOptions,
  modelParameters,
  autoEffort,
}: Pick<
  RouteEditorProps,
  'provider' | 'model' | 'effort' | 'effortOptions' | 'fast' | 'fastVisible' | 'contextVisible' | 'autoEffort'
> & {
  modelParameterOptions: NonNullable<RouteEditorProps['modelParameterOptions']>;
  modelParameters: Record<string, string>;
}) {
  const selectedEffort = effortOptions.find((option) => option.value === effort);
  // `autoEffort` is only passed for a capable model.
  const autoEffortOn = displayEffortLabel(effort, { autoOn: autoEffort?.enabled === true, capable: true }) !== null;
  // "Auto" is the effort's name (like "Fast"), shown untranslated on the model
  // chip and the Reasoning effort row.
  const effortLabel = autoEffortOn ? 'Auto' : selectedEffort?.label || '';
  const ultrafastAvailable = modelParameterOptions.some(
    (parameter) => parameter.id === 'serviceTier' && parameter.options.some((option) => option.value === 'ultrafast')
  );
  const speed = routeSpeed(fast, modelParameters);
  const speedLabels = { standard: t('Standard'), fast: t('Fast'), ultrafast: t('Ultrafast') };
  const speedLabel = speedLabels[speed];
  // The slider row IS the context control (TUI parity): a provider's own
  // context-window parameter (Cursor 272K/1M) must never duplicate it.
  // `serviceTier` is hidden only while the Speed row writes it (Fast/Ultrafast);
  // without a Speed row (e.g. Vertex) the generic row picks Standard/Flex/Priority.
  // Daybreak Blue is the switch under Auto reasoning, never a generic row.
  const parameterRows = modelParameterOptions.filter(
    (parameter) =>
      !(fastVisible && parameter.id === 'serviceTier') &&
      parameter.id !== DAYBREAK_PARAMETER_ID &&
      !(contextVisible && parameter.id === 'context')
  );
  const daybreakRow =
    Boolean(provider && model) && modelParameterOptions.some((parameter) => parameter.id === DAYBREAK_PARAMETER_ID);
  const daybreakOn = routeDaybreakBlue(modelParameters, modelParameterOptions);
  const rows = routeSheetRows({
    hasModel: Boolean(provider && model),
    effortCount: effortOptions.length,
    contextVisible,
    fastVisible,
    parameterIds: parameterRows.map((parameter) => parameter.id),
  });
  const sheetHeight = (rows.length + (daybreakRow ? 1 : 0)) * ROUTE_SHEET_ROW_HEIGHT + ROUTE_PANEL_PADDING * 2;
  return {
    autoEffortOn,
    effortLabel,
    ultrafastAvailable,
    speed,
    speedLabel,
    parameterRows,
    daybreakRow,
    daybreakOn,
    rows,
    sheetHeight,
  };
}

export function RouteEditor({
  models,
  provider,
  model,
  triggerModel,
  effort,
  effortOptions,
  fast,
  fastVisible,
  fastAvailable,
  contextVisible,
  contextPercent,
  contextDefaultPercent,
  contextTokens,
  contextExactTokens = 0,
  contextMaxTokens = 0,
  contextDefaultTokens = 0,
  modelParameterOptions = [],
  modelParameters = {},
  providerNames,
  catalogLoaded,
  catalogRefreshing,
  catalogError,
  providerSetupError,
  modelDisabled,
  tuningDisabled,
  tooltip = '',
  onSelectModel,
  onChangeEffort,
  onChangeSpeed,
  onChangeContext,
  onChangeModelParameter,
  onOpenProviders,
  onOpenModelManagement,
  onSetModelPreference,
  onOpenModelPane,
  autoEffort = null,
  onChangeAutoEffort = () => {},
  onOpenSheet,
  answersModelPickerRequests = false,
  placement = 'above',
  align = 'start',
  dropdown = false,
  sessionChoices = [],
}: RouteEditorProps) {
  const surfaceActive = useSurfaceActive();
  const sheetId = useId().replace(/:/g, '');
  const {
    autoEffortOn,
    effortLabel,
    ultrafastAvailable,
    speed,
    speedLabel,
    parameterRows,
    daybreakRow,
    daybreakOn,
    rows,
    sheetHeight: routeRowsHeight,
  } = routeSheetContent({
    provider,
    model,
    effort,
    effortOptions,
    fast,
    fastVisible,
    contextVisible,
    modelParameterOptions,
    modelParameters,
    autoEffort,
  });
  const sheetHeight =
    routeRowsHeight +
    (sessionChoices.length ? sessionChoices.length * ROUTE_SHEET_ROW_HEIGHT + ROUTE_SEPARATOR_HEIGHT : 0);
  const sheetState = useRouteSheet({
    dropdown,
    placement,
    align,
    sheetHeight,
    effortCount: effortOptions.length + (autoEffort ? 1 : 0),
    surfaceActive,
    onOpenSheet,
  });
  const { closing, visible, mounted, pane, setPane, drill, sheetBox, flyoutBox, triggerWidth, refs } = sheetState;
  const { layoutFor, show, toggle, closeAll, closePane } = sheetState;
  const { trigger, sheet, optionFlyout, modelFlyout, rowButtons, hoverLock, morphFrom } = refs;
  const { modelCatalogReady, hoverSwitchTimer, openPane, focusPane } = useRoutePaneNavigation({
    sheetId,
    modelCount: models.length,
    tuningDisabled,
    respondsToModelPicker: answersModelPickerRequests && surfaceActive && !modelDisabled,
    onOpenModelPane,
    setPane,
    hoverLock,
    layoutFor,
    show,
    refs,
  });
  const { paneLabel, paneHeader, paneBody } = useRoutePaneContent({
    pane,
    drill,
    closePane,
    sheet,
    optionFlyout,
    sessionChoices,
    parameterRows,
    modelParameters,
    tuningDisabled,
    effort,
    effortOptions,
    autoEffort,
    autoEffortOn,
    speed,
    fastAvailable,
    ultrafastAvailable,
    contextPercent,
    contextDefaultPercent,
    contextTokens,
    contextExactTokens,
    contextMaxTokens,
    contextDefaultTokens,
    onChangeEffort,
    onChangeAutoEffort,
    onChangeSpeed,
    onChangeContext,
    onChangeModelParameter,
  });
  useRouteFontWarmup();
  const row = (id: RouteSheetPane, label: string, value: ReactNode, disabled = false) => (
    <RouteRow
      key={id}
      id={id}
      label={label}
      value={value}
      disabled={disabled}
      pane={pane}
      dropdown={dropdown}
      hoverLock={hoverLock}
      hoverSwitchTimer={hoverSwitchTimer}
      rowButtons={rowButtons}
      sheet={sheet}
      openPane={openPane}
      focusPane={focusPane}
    />
  );
  // Drilled: ONE panel — the sheet itself takes the pane's box and content,
  // so the menu stays a single window growing out of the pill instead of a
  // second card floating over it (user: 한 창이라는 느낌이 덜하다).
  const drilled = drill && Boolean(pane);
  const panelBox = drilled && flyoutBox ? flyoutBox : sheetBox;
  // One catalog, hosted either by the drilled sheet or by its own flyout.
  const renderModelCatalog = (active: boolean) => (
    <ModelCatalog
      models={models}
      provider={provider}
      model={model}
      providerNames={providerNames}
      active={active}
      catalogLoaded={catalogLoaded}
      catalogRefreshing={catalogRefreshing}
      catalogError={catalogError}
      providerSetupError={providerSetupError}
      onSelect={onSelectModel}
      onClose={() => closePane('model', true)}
      onOpenProviders={() => {
        closeAll();
        onOpenProviders?.();
      }}
      onOpenModelManagement={
        onOpenModelManagement &&
        ((target?: string) => {
          closeAll();
          onOpenModelManagement(target);
        })
      }
      onSetModelPreference={onSetModelPreference}
    />
  );

  return (
    <div className="route-editor">
      <RouteTrigger
        triggerRef={trigger}
        disabled={modelDisabled}
        width={triggerWidth}
        tooltip={tooltip}
        visible={visible}
        sheetId={sheetId}
        triggerModel={triggerModel}
        effort={autoEffortOn ? '' : effort}
        fast={fast}
        ultra={speed === 'ultrafast'}
        blue={daybreakOn}
        effortLabel={effortLabel}
        onShow={show}
        onToggle={toggle}
      />
      {mounted &&
        panelBox &&
        createPortal(
          <div
            ref={sheet}
            id={`route-sheet-${sheetId}`}
            className="route-sheet"
            role="menu"
            aria-label={drilled && pane ? paneLabel(pane) : t('Choose model')}
            style={routeMorphStyle(panelBox, morphFrom.current)}
            data-placement={panelBox.placement}
            data-align={align}
            data-drilled={drilled ? '' : undefined}
            data-dropdown={dropdown ? '' : undefined}
            data-state={closing ? 'closing' : 'open'}
          >
            {drilled && pane && (
              <div className="route-sheet-pane" key={`pane:${pane}`}>
                {paneHeader(paneLabel(pane), pane)}
                {pane === 'model' ? renderModelCatalog(true) : paneBody(pane)}
              </div>
            )}
            {!(drilled && pane) && (
              <RouteSheetRows
                row={row}
                rows={rows}
                triggerModel={triggerModel}
                effortLabel={effortLabel}
                contextTokens={contextTokens}
                parameterRows={parameterRows}
                modelParameters={modelParameters}
                speed={speed}
                speedLabel={speedLabel}
                daybreakRow={daybreakRow}
                daybreakOn={daybreakOn}
                tuningDisabled={tuningDisabled}
                sessionChoices={sessionChoices}
                onChangeModelParameter={onChangeModelParameter}
              />
            )}
          </div>,
          document.body
        )}
      {modelCatalogReady &&
        !drill &&
        surfaceActive &&
        createPortal(
          <div
            ref={modelFlyout}
            className="route-sheet-flyout route-sheet-flyout--model"
            hidden={pane !== 'model'}
            data-placement={flyoutBox?.placement}
            data-state={closing ? 'closing' : 'open'}
            style={pane === 'model' && flyoutBox ? routePanelStyle(flyoutBox) : { display: 'none' }}
          >
            {renderModelCatalog(pane === 'model')}
          </div>,
          document.body
        )}
      {mounted &&
        !drill &&
        pane &&
        pane !== 'model' &&
        flyoutBox &&
        createPortal(
          <div
            ref={optionFlyout}
            className="route-sheet-flyout"
            role="menu"
            aria-label={paneLabel(pane)}
            style={routePanelStyle(flyoutBox)}
            data-placement={flyoutBox.placement}
            data-state={closing ? 'closing' : 'open'}
          >
            {paneHeader(paneLabel(pane), pane)}
            {paneBody(pane)}
          </div>,
          document.body
        )}
    </div>
  );
}
