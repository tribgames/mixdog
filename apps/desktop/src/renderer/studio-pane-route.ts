import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';
import {
  callCapability,
  type laneSpec,
  type MediaKind,
  type MediaLane,
  modelControls,
  type StudioApi,
  type StudioOptions,
} from './studio-support';

type LaneSpec = ReturnType<typeof laneSpec>;

// Keeps the picked lane/model/options valid and mirrors the pane's route to the
// runtime as its default for agent `media` calls.
export function useStudioRouteSync({
  active,
  activeModel,
  api,
  kind,
  lane,
  laneId,
  model,
  setLaneId,
  setModel,
  setOptions,
  spec,
}: {
  active: boolean;
  activeModel: string;
  api: StudioApi | undefined;
  kind: MediaKind;
  lane: MediaLane | null;
  laneId: string;
  model: string;
  setLaneId: (id: string) => void;
  setModel: (model: string) => void;
  setOptions: Dispatch<SetStateAction<StudioOptions>>;
  spec: LaneSpec;
}) {
  // What this pane shows is the runtime's default: an agent `media` call that
  // omits lane/model runs on it. Pushed once per settled (kind, lane, model)
  // so a picker flicker never spams the daemon, and a failure never touches
  // the pane — the draft cache is local and stays authoritative here.
  const pushedDefault = useRef('');
  useEffect(() => {
    if (!active || !lane || !activeModel || lane.id !== laneId || model !== activeModel) return;
    const key = `${kind}|${lane.id}|${activeModel}`;
    if (pushedDefault.current === key) return;
    pushedDefault.current = key;
    void callCapability(api, 'setMediaDefault', [{ kind, lane: lane.id, model: activeModel }]).catch(() => {
      // A host without the capability keeps the local selection only.
    });
  }, [active, activeModel, api, kind, lane, laneId, model]);

  // Keep lane/model selection valid whenever the kind or catalog changes.
  useEffect(() => {
    if (!lane) return;
    if (lane.id !== laneId) setLaneId(lane.id);
    if (model !== activeModel) setModel(activeModel);
  }, [activeModel, lane, laneId, model, setLaneId, setModel]);

  // Snap options onto the selected model's contract: a value carried over from
  // another model (1k resolution, a 12s clip on Veo) must never reach the API.
  useEffect(() => {
    const next = modelControls(spec, activeModel);
    setOptions((current) => {
      const patch: Partial<StudioOptions> = {};
      if (next.resolution?.length && !next.resolution.includes(current.resolution)) {
        patch.resolution = next.resolution[0];
      }
      if (next.aspectRatio?.length && !next.aspectRatio.includes(current.aspectRatio)) {
        patch.aspectRatio = next.aspectRatio[0];
      }
      // Duration is NOT snapped here: a patch that fed back into this effect
      // could re-enter on every render. The request clamps it instead.
      return Object.keys(patch).length ? { ...current, ...patch } : current;
    });
  }, [activeModel, setOptions, spec]);
}
