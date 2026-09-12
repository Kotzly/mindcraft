// How a model reasons before answering, declared by every profile as "reasoning":
//   native - the model's own extended thinking (only for model classes with `static nativeThinking = true`)
//   tags   - the prompt asks for reasoning inside <think></think>, which the prompter strips from the reply
//   off    - neither
// A model config object (model, code_model, vision_model, planning_model) may set its own "reasoning",
// e.g. a local chat model with tags and a claude-cli coder with native thinking.
export const REASONING_MODES = ['native', 'tags', 'off'];

export const THINK_TAGS_INSTRUCTION = 'Before answering, reason briefly inside <think></think> tags, then write your reply after the closing tag. Only the text after </think> is shown to players.';

export function validateProfileReasoning(profile) {
    if (profile.reasoning === undefined)
        return `Profile "${profile.name}" must declare "reasoning" (one of ${REASONING_MODES.join(', ')})`;
    for (const key of ['reasoning', 'model', 'code_model', 'vision_model', 'planning_model']) {
        const mode = key === 'reasoning' ? profile.reasoning : profile[key]?.reasoning;
        if (mode !== undefined && !REASONING_MODES.includes(mode))
            return `Profile "${profile.name}" has invalid ${key === 'reasoning' ? '' : key + '.'}reasoning "${mode}" (expected one of ${REASONING_MODES.join(', ')})`;
    }
    return null;
}

export function resolveReasoning(profile, model_config) {
    return (typeof model_config === 'object' && model_config?.reasoning) || profile.reasoning;
}

// applies the mode to a created model, rejecting native thinking on models that can't do it
export function applyReasoning(model, mode) {
    if (mode === 'native' && !model.constructor.nativeThinking)
        throw new Error(`reasoning "native" is not supported by the ${model.constructor.prefix} API, use "tags" or "off"`);
    model.reasoning = mode;
    model.setReasoning?.(mode);
}

// appended to the prompt's first paragraph, so the first line still tells prompt kinds apart
export function addThinkTagsInstruction(prompt) {
    const end = prompt.indexOf('\n');
    if (end === -1)
        return `${prompt} ${THINK_TAGS_INSTRUCTION}`;
    return `${prompt.slice(0, end)} ${THINK_TAGS_INSTRUCTION}${prompt.slice(end)}`;
}
