import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

export const MEDIA_ACTIONS = Object.freeze(['list', 'generate', 'status', 'cancel']);
export const MEDIA_KINDS = Object.freeze(['image', 'video']);

/** The lane catalog (which providers, models, and controls exist) lives in the
 *  runtime and is read through `list`; neither this description nor the media
 *  skill names a lane, so a provider change never strands the model. */
const MEDIA_SKILL_ROUTING = 'Load the image skill before the first image call and the video skill before the first video call.';

export const TOOL_DEFS = [
  {
    name: 'media',
    title: 'Mixdog Media Studio',
    description: 'Generate an image or a video through the Media Studio lanes the user signed in to, and write it to a file. '
      + MEDIA_SKILL_ROUTING
      + ' generate needs kind, prompt, and path. '
      + TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: MEDIA_ACTIONS, description: 'list: signed-in lanes (narrow with kind, then model); generate: one image or video; status/cancel: a job by id.' },
        kind: { type: 'string', enum: MEDIA_KINDS, description: 'generate: required. list: filter.' },
        lane: { type: 'string', description: 'Lane id from list; omitted = the lane the user last chose for the kind (Studio selection or last generation), else the first signed-in lane.' },
        model: { type: 'string', description: 'Model id from list; omitted = the remembered model on that lane, else the lane default. list: return that model\'s controls.' },
        prompt: { type: 'string', description: 'generate: the brief, in the form the image/video skill gives.' },
        path: { type: 'string', description: 'generate: output file (png/jpg/mp4); relative to the project. status: copy a finished asset here.' },
        aspect: { type: 'string', description: 'Aspect ratio, e.g. 16:9, 9:16, 1:1; must be one the model lists.' },
        resolution: { type: 'string', description: 'Model resolution token from list (1k, 2k, 720p, 1080p).' },
        duration: { type: 'number', description: 'video: seconds, within the model\'s listed durations.' },
        quality: { type: 'string', description: 'Quality token when the model lists one.' },
        references: { type: 'array', items: { type: 'string' }, description: 'Reference image file paths (image-to-image, start frame); capped by the model.' },
        wait: { type: 'boolean', description: 'generate: wait for completion (default true); false returns a job id for status.' },
        job: { type: 'string', description: 'status/cancel: job id.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
