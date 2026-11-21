// @ts-check

/**
 * @file Behaviour of the shared refresh classifier used by the scheduler's
 * three refresh ladders.
 * @version 0.12.0
 *
 * @description
 * The classifier is pure: it reads only the refreshed record's state and the
 * two configured state lists. One outcome per record, with `missing` above
 * everything and `terminal` above `inactive`. Routability is decided by the
 * caller after `live`, never here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRefresh } from '../lib/agentic/scheduler/reconcile.mjs';
import { normalizeWorkItem } from '../lib/agentic/scheduler/normalize.mjs';

const TERMINAL_STATES = ['done', 'canceled'];
const ACTIVE_STATES = ['todo', 'in_progress'];

/**
 * @param {string} state
 * @param {boolean} [dispatchable] -
 * @returns {import('../lib/agentic/scheduler/normalize.mjs').WorkItem}
 */
function itemIn(state, dispatchable = true) {
    return normalizeWorkItem({
        raw: { id: 'item-1', identifier: 'MER-1', title: 'Fix the thing', state, dispatchable }
    });
}

test('missing when the refresh returned no record', () => {
    assert.equal(classifyRefresh({ item: undefined, terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }), 'missing');
});

test('terminal when the state is terminal', () => {
    assert.equal(classifyRefresh({ item: itemIn('done'), terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }), 'terminal');
});

test('inactive when the state is neither active nor terminal', () => {
    assert.equal(classifyRefresh({ item: itemIn('backlog'), terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }), 'inactive');
});

test('live when the state is active', () => {
    assert.equal(classifyRefresh({ item: itemIn('in_progress'), terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }), 'live');
});

test('missing wins over every state decision', () => {
    const states = ['todo', 'done'];
    assert.equal(classifyRefresh({ item: undefined, terminalStates: states, activeStates: states }), 'missing');
});

test('terminal wins over active and over inactive', () => {
    const both = ['done'];
    assert.equal(classifyRefresh({ item: itemIn('done'), terminalStates: both, activeStates: both }), 'terminal');
    assert.equal(classifyRefresh({ item: itemIn('backlog'), terminalStates: ['backlog'], activeStates: ACTIVE_STATES }), 'terminal');
});

test('state matching is trim + lowercase, as normalize defines it', () => {
    assert.equal(classifyRefresh({ item: itemIn(' DONE '), terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }), 'terminal');
});

test('a precomputed Set of states is accepted', () => {
    assert.equal(
        classifyRefresh({ item: itemIn('todo'), terminalStates: new Set(TERMINAL_STATES), activeStates: new Set(ACTIVE_STATES) }),
        'live'
    );
});

test('routability is not part of the classification', () => {
    assert.equal(
        classifyRefresh({ item: itemIn('todo', false), terminalStates: TERMINAL_STATES, activeStates: ACTIVE_STATES }),
        'live'
    );
});
