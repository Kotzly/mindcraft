import test from 'node:test';
import assert from 'node:assert/strict';
import { wordOverlapScore, strictFormat } from '../src/utils/text.js';

test('wordOverlapScore is 1 for identical text', () => {
    assert.equal(wordOverlapScore('hello world', 'hello world'), 1);
});

test('wordOverlapScore is 0 for disjoint text', () => {
    assert.equal(wordOverlapScore('abc', 'xyz'), 0);
});

test('wordOverlapScore is a fraction for partial overlap', () => {
    // words1=[hello,world], words2=[goodbye,world]; intersection=[world]
    // score = 1 / (2 + 2 - 1) = 1/3
    assert.equal(wordOverlapScore('hello world', 'goodbye world'), 1 / 3);
});

test('strictFormat prefixes and demotes system turns to user turns', () => {
    const turns = [{ role: 'system', content: 'sys msg' }, { role: 'user', content: 'hi' }];
    const result = strictFormat(turns);
    assert.deepEqual(result, [{ role: 'user', content: 'SYSTEM: sys msg\nhi' }]);
});

test('strictFormat inserts a filler user message between consecutive assistant turns', () => {
    const turns = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'a1' },
        { role: 'assistant', content: 'a2' },
    ];
    const result = strictFormat(turns);
    assert.deepEqual(result, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: '_' },
        { role: 'assistant', content: 'a2' },
    ]);
});

test('strictFormat prepends a filler user turn when history starts with the assistant', () => {
    const result = strictFormat([{ role: 'assistant', content: 'a1' }]);
    assert.deepEqual(result, [
        { role: 'user', content: '_' },
        { role: 'assistant', content: 'a1' },
    ]);
});

test('strictFormat returns a filler user turn for empty history', () => {
    assert.deepEqual(strictFormat([]), [{ role: 'user', content: '_' }]);
});
