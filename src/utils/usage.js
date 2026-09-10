// Token usage accumulated per model instance and shown on the MindServer dashboard.
// Only providers that call addUsage report anything; cost_usd stays null for local models.

function emptyUsage() {
    return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null };
}

export function addUsage(model, { input = 0, output = 0, cache_read = 0, cache_write = 0, cost_usd = null }) {
    const usage = model.usage ??= emptyUsage();
    usage.calls++;
    usage.input_tokens += input || 0;
    usage.output_tokens += output || 0;
    usage.cache_read_tokens += cache_read || 0;
    usage.cache_write_tokens += cache_write || 0;
    if (typeof cost_usd === 'number')
        usage.cost_usd = (usage.cost_usd || 0) + cost_usd;
}

// chat, code, vision and embedding models are often the same instance, so count each once
export function getAgentUsage(prompter) {
    const total = emptyUsage();
    const models = new Set([prompter.chat_model, prompter.code_model, prompter.vision_model, prompter.embedding_model]);
    for (const model of models) {
        const usage = model?.usage;
        if (!usage)
            continue;
        for (const key of ['calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'])
            total[key] += usage[key];
        if (usage.cost_usd !== null)
            total.cost_usd = (total.cost_usd || 0) + usage.cost_usd;
    }
    return total;
}
