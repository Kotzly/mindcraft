import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { validateProfileReasoning, resolveReasoning, applyReasoning, addThinkTagsInstruction, THINK_TAGS_INSTRUCTION } from '../src/models/reasoning.js';

test('every profile declares a valid reasoning mode', () => {
    const files = ['andy.json',
        ...readdirSync('profiles').filter(f => f.endsWith('.json')).map(f => `profiles/${f}`),
        ...readdirSync('profiles/tasks').filter(f => f.endsWith('.json')).map(f => `profiles/tasks/${f}`)];
    for (const file of files) {
        const profile = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(validateProfileReasoning(profile), null, file);
    }
});

test('validateProfileReasoning rejects a missing or unknown mode', () => {
    assert.match(validateProfileReasoning({ name: 'a' }), /must declare "reasoning"/);
    assert.match(validateProfileReasoning({ name: 'a', reasoning: 'maybe' }), /invalid reasoning "maybe"/);
    assert.match(validateProfileReasoning({ name: 'a', reasoning: 'off', code_model: { reasoning: 'yes' } }), /invalid code_model.reasoning/);
});

test('resolveReasoning prefers the model config over the profile', () => {
    const profile = { reasoning: 'off', code_model: { api: 'claude-cli', reasoning: 'native' } };
    assert.equal(resolveReasoning(profile, 'ollama/andy'), 'off');
    assert.equal(resolveReasoning(profile, profile.code_model), 'native');
});

test('applyReasoning rejects native thinking on models without it', () => {
    class Local { static prefix = 'ollama'; }
    class Thinker { static prefix = 'claude-cli'; static nativeThinking = true; }
    assert.throws(() => applyReasoning(new Local(), 'native'), /not supported by the ollama API/);
    const local = new Local();
    applyReasoning(local, 'tags');
    assert.equal(local.reasoning, 'tags');
    const thinker = new Thinker();
    applyReasoning(thinker, 'native');
    assert.equal(thinker.reasoning, 'native');
});

test('addThinkTagsInstruction extends the first line only', () => {
    assert.equal(addThinkTagsInstruction('You are $NAME.\n$STATS'), `You are $NAME. ${THINK_TAGS_INSTRUCTION}\n$STATS`);
    assert.equal(addThinkTagsInstruction('One line'), `One line ${THINK_TAGS_INSTRUCTION}`);
});
