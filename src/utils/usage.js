// Token usage accumulated per model instance and shown on the MindServer dashboard.
// Only providers that call addUsage report anything; cost_usd stays null for local models.

const COUNTERS = ['calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

export function createUsage(cost_usd = null) {
    return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd };
}

export function addUsage(model, { input = 0, output = 0, cache_read = 0, cache_write = 0, cost_usd = null }) {
    const usage = model.usage ??= createUsage();
    usage.calls++;
    usage.input_tokens += input || 0;
    usage.output_tokens += output || 0;
    usage.cache_read_tokens += cache_read || 0;
    usage.cache_write_tokens += cache_write || 0;
    if (typeof cost_usd === 'number')
        usage.cost_usd = (usage.cost_usd || 0) + cost_usd;
}

// chat, code, vision and embedding are often the same instance, so this groups the
// prompter's model roles by the (deduplicated) instance they actually point to.
function groupModelsByRole(prompter) {
    const roles = new Map();
    const by_role = [
        ['chat', prompter.chat_model],
        ['code', prompter.code_model],
        ['vision', prompter.vision_model],
        ['embedding', prompter.embedding_model]
    ];
    for (const [role, model] of by_role) {
        if (model?.usage)
            roles.set(model, [...(roles.get(model) || []), role]);
    }
    return roles;
}

// Totals over the agent's models plus a per-model breakdown.
export function getAgentUsage(prompter) {
    const roles = groupModelsByRole(prompter);

    const total = createUsage();
    total.models = [];
    for (const [model, model_roles] of roles) {
        for (const key of COUNTERS)
            total[key] += model.usage[key];
        if (model.usage.cost_usd !== null)
            total.cost_usd = (total.cost_usd || 0) + model.usage.cost_usd;
        const sessions = model.getSessions ? model.getSessions() : undefined;
        total.models.push({ roles: model_roles, api: model.constructor.prefix, model: model.model_name || 'default', sessions, ...model.usage });
    }
    return total;
}

// Snapshot of cumulative usage for persisting across restarts (models are recreated fresh
// on every startup, so counts otherwise reset to zero), keyed by which roles share an instance.
export function snapshotAgentUsage(prompter) {
    const roles = groupModelsByRole(prompter);
    const snapshot = {};
    for (const [model, model_roles] of roles)
        snapshot[model_roles.join('+')] = { ...model.usage };
    return snapshot;
}

// Restores a snapshot from snapshotAgentUsage onto the freshly-created models of a new
// Prompter, matched by role grouping. Silently skips roles the snapshot doesn't have (e.g.
// the profile's model config changed since the snapshot was saved).
export function restoreAgentUsage(prompter, snapshot) {
    if (!snapshot)
        return;
    const roles = groupModelsByRole(prompter);
    for (const [model, model_roles] of roles) {
        const saved = snapshot[model_roles.join('+')];
        if (saved)
            Object.assign(model.usage, saved);
    }
}
