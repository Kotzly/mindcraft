import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoList } from '../src/agent/todo_list.js';

test('parseSteps strips leading numbering/dashes and a trailing X marker', () => {
    const text = '1. Get wood\n- Mine stone\n3. Build a house X';
    const steps = TodoList.parseSteps(text);
    assert.deepEqual(steps, ['Get wood', 'Mine stone', 'Build a house']);
});

test('parseSteps caps the result at 12 steps', () => {
    const text = Array.from({ length: 20 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
    const steps = TodoList.parseSteps(text);
    assert.equal(steps.length, 12);
});

test('parseNumberedGoal returns steps when sequentially numbered from 1', () => {
    const text = '1. Get wood\n2. Craft planks\n3. Craft pickaxe';
    assert.deepEqual(TodoList.parseNumberedGoal(text), ['Get wood', 'Craft planks', 'Craft pickaxe']);
});

test('parseNumberedGoal returns null when numbering does not start at 1 or is out of order', () => {
    assert.equal(TodoList.parseNumberedGoal('2. Get wood\n3. Craft pickaxe'), null);
    assert.equal(TodoList.parseNumberedGoal('1. Get wood\n3. Craft pickaxe'), null);
});

test('parseNumberedGoal returns null with fewer than 2 numbered steps', () => {
    assert.equal(TodoList.parseNumberedGoal('1. Get wood'), null);
});

test('parseNumberedGoal rejects steps that look like coordinates', () => {
    const text = '1. Go to the base\n2. Build at 10, 20, 30';
    assert.equal(TodoList.parseNumberedGoal(text), null);
});

test('done() marks the current step done and advances to the next', () => {
    const list = new TodoList();
    list.set(['a', 'b', 'c']);
    assert.equal(list.done(1), "Step 1 done. Next step is 2: 'b'.");
    assert.equal(list.current().number, 2);
});

test('done(0) or done() with no argument defaults to the current step', () => {
    const list = new TodoList();
    list.set(['a', 'b']);
    assert.equal(list.done(0), "Step 1 done. Next step is 2: 'b'.");
    assert.equal(list.done(), 'All todo steps are done. If the goal is fully met use !endGoal. If it is ongoing or not met, add the next steps with !setTodo.');
});

test('done(n) rejects a step number that is not the current step', () => {
    const list = new TodoList();
    list.set(['a', 'b', 'c']);
    const msg = list.done(2);
    assert.match(msg, /is not the current step/);
});

test('done(n) reports an already-done step when it was completed out of order', () => {
    const list = new TodoList();
    list.set(['a', 'b', 'c']);
    list.items[1].done = true; // mark step 2 done directly, leaving step 1 as current
    assert.equal(list.done(2), "Step 2 is already done. The current step is 1: 'a'.");
});

test('tick()/isStuck() flags after 10 attempts and resets on progress', () => {
    const list = new TodoList();
    list.set(['a']);
    for (let i = 0; i < 10; i++) list.tick();
    assert.equal(list.isStuck(), true);
    list.done(1);
    assert.equal(list.attempts, 0);
});

test('add() inserts the new step before the current one', () => {
    const list = new TodoList();
    list.set(['a', 'b']);
    list.add('a.5');
    assert.deepEqual(list.items.map(i => i.text), ['a.5', 'a', 'b']);
});
