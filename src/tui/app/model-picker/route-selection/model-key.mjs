// model-picker/route-selection/model-key.mjs
// The row identity the per-row selection maps (effort, Fast, parameters,
// context percent) are keyed by. One model is one provider+id pair, and the
// same key has to address it from every selection module.
export const modelKey = (model) => `${model?.provider || ''}\n${model?.id || ''}`;
