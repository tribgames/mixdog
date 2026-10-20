// An agent's face: the Mixdog mascot as layered pixel SVG (design/mockups/
// mixy-art), or the user's own images per motion state. No disc or frame;
// the colours are the agent's content, not icon ink, so they stay as picked.
// A face asked to move (`state`) moves only while it holds the stage
// (avatar-motion.ts); every other face shows its still frame.
import { type CSSProperties, memo, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_AVATAR_COLORS,
  type AgentAvatarState,
  type AgentAvatarValue,
  type CustomAvatar,
  MASCOT_ACCESSORIES,
  MASCOT_SPECIES,
  MIXY_AVATAR,
  type MascotAvatar as MascotAvatarValue,
  type MascotCell,
  cellPaths,
  customAvatarStateFile,
  defaultAgentAvatar,
  mascotLook,
  mascotParts,
} from '../../../../src/runtime/shared/agent-avatar.mjs';
import { type AvatarMotionState, useAvatarMotion, useReducedMotion } from './avatar-motion';
import { t } from './i18n';
import './agent-avatar.css';

export type { MascotAvatarValue };

/** A new agent's first look: the first dog, plain and calm, in the first colour. */
export const NEW_AGENT_AVATAR: MascotAvatarValue = {
  kind: 'mascot',
  species: MASCOT_SPECIES[0],
  accessory: 'none',
  expression: 'calm',
  color: AGENT_AVATAR_COLORS[0],
};

type MascotLookValue = Pick<MascotAvatarValue, 'species' | 'accessory' | 'expression' | 'color'>;

function Cells({ cells }: { cells: MascotCell[] }) {
  return (
    <>
      {cellPaths(cells).map(({ fill, d }) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </>
  );
}

/** The mascot on its full 16x12 grid, in groups the motion states move
 *  (tail, legs, bob > ear, eyes; fx). In a box 32, 48 or 80px wide each cell
 *  is a whole 2, 3 or 5px. */
export const MascotAvatar = memo(function MascotAvatar({
  avatar,
  className,
  state = 'still',
  ref,
}: {
  avatar: MascotLookValue;
  className?: string;
  state?: AvatarMotionState;
  ref?: Ref<SVGSVGElement>;
}) {
  const { species, accessory, expression, color } = avatar;
  const parts = useMemo(
    () => mascotParts({ species, accessory, expression, color }),
    [species, accessory, expression, color]
  );
  if (!parts) return null;
  return (
    <svg
      ref={ref}
      className={`mx-av${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 12"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-look={mascotLook(avatar)}
      data-color={color}
      data-state={state}
    >
      <g className="tail">
        <Cells cells={parts.tail} />
      </g>
      <g className="legs">
        <Cells cells={parts.legs} />
      </g>
      <g className="bob">
        <Cells cells={parts.body} />
        <g className="ear">
          <Cells cells={parts.ear} />
        </g>
        <Cells cells={parts.marks} />
        <g className="eyes">
          <g className="eyes-open">
            <Cells cells={parts.eyes} />
          </g>
          <g className="eyes-shut" opacity={0}>
            <Cells cells={parts.blink} />
          </g>
        </g>
        <Cells cells={parts.accessory} />
      </g>
      <g className="fx" />
    </svg>
  );
});

/** One state image: the image, and its still first frame ('' = itself). */
export interface AvatarImage {
  url: string;
  poster: string;
}
/** Images by file name. */
export type AvatarImages = Readonly<Record<string, AvatarImage>>;

// A custom avatar's images by `<agent id>/<file names>`: every name is a
// content hash, so a cached answer never goes stale. Fetched once per renderer.
const imageCache = new Map<string, Promise<AvatarImages>>();
const NO_IMAGES: AvatarImages = {};

function agentAvatarImages(agentId: string, avatar: CustomAvatar): Promise<AvatarImages> {
  const files = Object.values(avatar.states);
  const key = `${agentId}/${files.join('/')}`;
  let images = imageCache.get(key);
  if (!images) {
    images = Promise.resolve(
      window.mixdogDesktop?.invokeCapability?.<{
        states?: Record<string, { file?: string; url?: string; poster?: string }>;
      } | null>({ capability: 'getAgentAvatarImage', args: [agentId] })
    )
      .then((result) => {
        const found: Record<string, AvatarImage> = {};
        for (const image of Object.values(result?.value?.states ?? {})) {
          const file = String(image?.file || '');
          if (!files.includes(file) || !image?.url?.startsWith('data:image/')) continue;
          found[file] = { url: image.url, poster: image.poster?.startsWith('data:image/png;') ? image.poster : '' };
        }
        return found;
      })
      .catch(() => NO_IMAGES);
    imageCache.set(key, images);
  }
  return images;
}

/** The saved images of `avatar` (none for a mascot), once read. */
export function useAgentAvatarImages(agentId: string, avatar: AgentAvatarValue | null): AvatarImages {
  const [images, setImages] = useState<AvatarImages>(NO_IMAGES);
  const custom = avatar?.kind === 'custom' ? avatar : null;
  const key = custom ? Object.values(custom.states).join('/') : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the avatar's file names
  useEffect(() => {
    setImages(NO_IMAGES);
    if (!custom) return undefined;
    let live = true;
    void agentAvatarImages(agentId, custom).then((found) => {
      if (live) setImages(found);
    });
    return () => {
      live = false;
    };
  }, [agentId, key]);
  return images;
}

/** A custom image as a square, cover-cropped face. */
export function AgentImageAvatar({
  src,
  className,
  state,
  ref,
}: {
  src: string;
  className?: string;
  state?: AvatarMotionState;
  ref?: Ref<HTMLImageElement>;
}) {
  return (
    <img
      ref={ref}
      className={`agent-avatar-image${className ? ` ${className}` : ''}`}
      src={src}
      alt=""
      draggable={false}
      data-state={state}
    />
  );
}

/** Which source a custom face shows: the state's animation while it moves;
 *  otherwise a still first frame — of the asked state under reduced motion,
 *  else of idle. A missing state uses idle's image. */
export function customAvatarSource(
  image: (state: AgentAvatarState) => AvatarImage | undefined,
  requested: AvatarMotionState,
  shown: AvatarMotionState,
  reduced: boolean
): string {
  if (shown !== 'still') {
    const moving = image(shown);
    return moving?.url ?? '';
  }
  const still = image(reduced && requested !== 'still' ? requested : 'idle');
  return still ? still.poster || still.url : '';
}

/** An agent's face: its mascot, or its own images (its id-derived mascot
 *  shows until, or if, they cannot be read). `state` asks for a motion. */
export function AgentAvatar({
  agentId,
  avatar,
  className,
  state = 'still',
  priority,
}: {
  agentId: string;
  avatar: AgentAvatarValue;
  className?: string;
  state?: AvatarMotionState;
  /** Below the state's own rank: a list row yields to the open chat. */
  priority?: number;
}) {
  const element = useRef<Element | null>(null);
  const shown = useAvatarMotion(state, element, priority);
  const reduced = useReducedMotion();
  const images = useAgentAvatarImages(agentId, avatar);
  if (avatar.kind === 'custom') {
    const src = customAvatarSource((motion) => images[customAvatarStateFile(avatar, motion)], state, shown, reduced);
    if (src) {
      return (
        <AgentImageAvatar
          ref={(node) => {
            element.current = node;
          }}
          src={src}
          className={className}
          state={shown}
        />
      );
    }
  }
  return (
    <MascotAvatar
      ref={(node) => {
        element.current = node;
      }}
      avatar={avatar.kind === 'mascot' ? avatar : defaultAgentAvatar(agentId)}
      className={className}
      state={shown}
    />
  );
}

const SPECIES_LABELS: Record<string, () => string> = {
  labrador: () => t('Labrador'),
  shepherd: () => t('Shepherd'),
  terrier: () => t('Terrier'),
  corgi: () => t('Corgi'),
  husky: () => t('Husky'),
  shiba: () => t('Shiba'),
};
const ACCESSORY_LABELS: Record<string, () => string> = {
  none: () => t('None'),
  collar: () => t('Collar'),
  glasses: () => t('Glasses'),
  beanie: () => t('Beanie'),
  scarf: () => t('Scarf'),
  bow: () => t('Bow'),
};

type LookField = 'species' | 'accessory';

/** One labelled row of choices, each a small face in the current look. */
function PickRow({
  field,
  label,
  options,
  labels,
  value,
  unpicked = false,
  signature,
  disabled,
  onChange,
}: {
  /** The signature look is on: no dog in this row is the current pick. */
  unpicked?: boolean;
  /** The representative's own default look, offered first in the row. */
  signature?: MascotAvatarValue;
  field: LookField;
  label: string;
  options: readonly string[];
  labels: Record<string, () => string>;
  value: MascotAvatarValue;
  disabled: boolean;
  onChange(next: MascotAvatarValue): void;
}) {
  return (
    <div className="agent-avatar-row">
      <span className="agent-avatar-row-label">{label}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form fieldset */}
      <div className="agent-avatar-options" role="group" aria-label={label}>
        {signature && (
          <button
            type="button"
            data-signature="true"
            aria-pressed={unpicked}
            disabled={disabled}
            onClick={() => onChange({ ...value, species: signature.species, expression: signature.expression })}
          >
            <MascotAvatar avatar={signature} />
            <span>{t('Default')}</span>
          </button>
        )}
        {options.map((option) => (
          <button
            type="button"
            key={option}
            {...{ [`data-${field}`]: option }}
            aria-pressed={!unpicked && value[field] === option}
            disabled={disabled}
            onClick={() => onChange({ ...value, [field]: option })}
          >
            <MascotAvatar avatar={{ ...value, [field]: option }} />
            <span>{labels[option]()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Mixy's own look exactly as it ships: stored as no avatar. Any accessory or
 *  colour on it is stored as the species `mixy` with that accessory/colour. */
export const isSignatureDefault = (avatar: MascotAvatarValue): boolean =>
  mascotLook(avatar) === mascotLook(MIXY_AVATAR) && avatar.color === MIXY_AVATAR.color;

/** The mascot picker: the kind (the dogs), accessory and colour rows
 *  (design/mockups/mixy-art §1). There is no expression row: the avatar's
 *  motions and status images carry that, and a stored `expression` is kept. */
export function AgentAvatarPicker({
  value,
  signature,
  disabled = false,
  compact = false,
  onChange,
}: {
  value: MascotAvatarValue;
  /** The representative's own default look, offered first in the Kind row (기본). */
  signature?: MascotAvatarValue;
  disabled?: boolean;
  /** Smaller rows, for an editor that is not about the avatar. */
  compact?: boolean;
  onChange(next: MascotAvatarValue): void;
}) {
  const own = signature && value.species === signature.species;
  // The signature look takes the accessory and colour like any dog.
  const row = { value, disabled, onChange };
  return (
    <div className="agent-avatar-picker" data-compact={compact ? 'true' : undefined}>
      <PickRow
        field="species"
        label={t('Kind')}
        options={MASCOT_SPECIES}
        labels={SPECIES_LABELS}
        signature={signature}
        unpicked={Boolean(own)}
        {...row}
      />
      <PickRow
        field="accessory"
        label={t('Accessory')}
        options={MASCOT_ACCESSORIES}
        labels={ACCESSORY_LABELS}
        {...row}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle swatches, not a form fieldset */}
      <div className="agent-avatar-colors" role="group" aria-label={t('Avatar color')}>
        {AGENT_AVATAR_COLORS.map((color, index) => (
          <button
            type="button"
            key={color}
            data-color={color}
            aria-label={t('Color {{number}}', { number: index + 1 })}
            aria-pressed={color === value.color}
            disabled={disabled}
            style={{ '--agent-avatar-swatch': color } as CSSProperties}
            onClick={() => onChange({ ...value, color })}
          />
        ))}
      </div>
    </div>
  );
}
