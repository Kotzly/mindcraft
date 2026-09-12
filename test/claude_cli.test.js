import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSession, renderTurns } from '../src/models/claude_cli.js';

test('matchSession finds a full match with nothing dropped', () => {
    const session_turns = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello there' }, // CLI's full reply
    ];
    const turns = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }, // mindcraft's (possibly truncated) copy
    ];
    assert.deepEqual(matchSession(session_turns, turns), { synced: 2, dropped: 0 });
});

test('matchSession reports a trailing rejected reply as dropped', () => {
    const session_turns = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'bad reply' },
    ];
    const turns = [
        { role: 'user', content: 'hi' }, // mindcraft discarded the rejected reply
    ];
    assert.deepEqual(matchSession(session_turns, turns), { synced: 1, dropped: 1 });
});

test('matchSession returns synced:0 when history no longer overlaps', () => {
    const session_turns = [{ role: 'user', content: 'abc' }];
    const turns = [{ role: 'user', content: 'xyz' }];
    assert.deepEqual(matchSession(session_turns, turns), { synced: 0, dropped: 0 });
});

test('renderTurns labels system and assistant turns, leaves user turns bare', () => {
    const turns = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
    ];
    assert.equal(renderTurns(turns), 'SYSTEM: sys\nhi\nYour output: hey');
});

test('sendStatelessRequest runs every turn in an unsaved one-shot session', async () => {
    const { ClaudeCLI } = await import('../src/models/claude_cli.js');
    const model = new ClaudeCLI('haiku', null, {});
    const calls = [];
    model._run = async (args, prompt) => {
        calls.push({ args, prompt });
        return { result: 'ok' };
    };
    const turns = [{ role: 'user', content: 'player: build a hut ' }, { role: 'system', content: 'Code output: error' }];
    assert.equal(await model.sendStatelessRequest(turns, 'You are a coder.'), 'ok');
    assert.equal(await model.sendStatelessRequest(turns, 'You are a coder.'), 'ok');
    for (const { args, prompt } of calls) {
        assert.ok(args.includes('--no-session-persistence'));
        assert.ok(!args.includes('--resume') && !args.includes('--session-id'));
        assert.equal(prompt, 'player: build a hut\nSYSTEM: Code output: error');
    }
    assert.deepEqual(model.getSessions(), []);
});
