// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { declaresParam, ProfileManager } from '../lib/backends/jai-vendor/profiles.mjs';
import { ChatSession as JaiChatSession } from '../lib/backends/jai.mjs';

test('declaresParam: bare keys match', () => {
    assert.equal(declaresParam({ params: new Set(['temperature', 'topP']), key: 'temperature' }), true);
    assert.equal(declaresParam({ params: new Set(['temperature']), key: 'topP' }), false);
});

test('declaresParam: dotted toolConfig paths match the bare probe', () => {
    const params = new Set(['toolConfig.toolChoice.named', 'toolConfig.tools', 'toolConfig.parallelToolCalls']);
    assert.equal(declaresParam({ params, key: 'named' }), true);
    assert.equal(declaresParam({ params, key: 'tools' }), true);
    assert.equal(declaresParam({ params, key: 'parallelToolCalls' }), true);
    assert.equal(declaresParam({ params, key: 'auto' }), false);
    assert.equal(declaresParam({ params, key: 'none' }), false);
});

test('declaresParam: unknown/undisclosed is permissive, never drops', () => {
    assert.equal(declaresParam({ params: /** @type {any} */ (null), key: 'named' }), true);
    assert.equal(declaresParam({ params: /** @type {any} */ (undefined), key: 'named' }), true);
    assert.equal(declaresParam({ params: new Set(), key: 'named' }), true);
});

/** @param {string[]} paramsList @returns {ProfileManager} */
/** @param {{paramsList: *}} arg0 */
const makeManager = ({ paramsList }) => {
    const httpClient = {
        _fetchWithRetry: async () => ({
            json: async () => ({ profiles: [{ id: 'm1', chatDefinition: { parameters: paramsList } }] })
        }),
        getEventEmitter: () => new EventEmitter(),
        streamTimeout: 1000
    };
    return new ProfileManager({ httpClient, cacheTTL: 60000 });
};

test('ProfileManager.isSupported: dotted-only profile supports the family', async () => {
    const manager = makeManager({ paramsList: ['toolConfig.toolChoice.named', 'toolConfig.tools', 'toolConfig.parallelToolCalls'] });
    await manager.getProfiles();
    assert.equal(manager.isSupported({ profileId: 'm1', paramKey: 'named' }), true);
    assert.equal(manager.isSupported({ profileId: 'm1', paramKey: 'tools' }), true);
    assert.equal(manager.isSupported({ profileId: 'm1', paramKey: 'parallelToolCalls' }), true);
    assert.equal(manager.isSupported({ profileId: 'm1', paramKey: 'auto' }), false);
    assert.equal(manager.isSupported({ profileId: 'unknown-profile', paramKey: 'anything' }), true);
});

/** @param {string[]} paramsList @param {EventEmitter} emitter @returns {Promise<any>} */
/** @param {{paramsList: *, emitter?: *}} arg0 */
const makeAgenticSession = async ({ paramsList, emitter = new EventEmitter() }) => {
    const manager = makeManager({ paramsList });
    await manager.getProfiles();
    const session = new JaiChatSession({ httpClient: /** @type {any} */ ({}), profile: 'm1', eventEmitter: emitter, profileManager: manager });
    session.withTools({ tools: [{ name: 'search', description: 'd', parameters: { type: 'object', properties: {} } }] });
    return session;
};

test('JAI: undisclosed profile (empty params) keeps an explicit named tool choice', async () => {
    const session = await makeAgenticSession({ paramsList: [] });
    session.withParameters({ params: { toolChoice: { type: 'named', name: 'search' } } });
    assert.deepEqual(/** @type {any} */ (session)._parameters.toolConfig.toolChoice, { named: 'search' });
});

test('JAI: dotted-declared profile keeps the tool choice on the wire config', async () => {
    const session = await makeAgenticSession({ paramsList: ['toolConfig.toolChoice.named', 'toolConfig.tools'] });
    session.withParameters({ params: { toolChoice: { type: 'named', name: 'search' } } });
    assert.deepEqual(/** @type {any} */ (session)._parameters.toolConfig.toolChoice, { named: 'search' });
});

test('JAI: known-unsupported tool choice is dropped with a parameter_warning', async () => {
    const warnings = [];
    const emitter = new EventEmitter();
    emitter.on('parameter_warning', (w) => warnings.push(w));
    const session = await makeAgenticSession({ paramsList: ['temperature'], emitter });
    session.withParameters({ params: { toolChoice: { type: 'named', name: 'search' } } });
    assert.equal(/** @type {any} */ (session)._parameters.toolConfig.toolChoice, undefined);
    assert.ok(warnings.length > 0, 'expected a parameter_warning for the unsupported choice');
});


test('JAI: a profile-filtered cachePoints warns under cachePoints, not CACHE_POINTS', async () => {
    /** @type {any[]} */
    const warnings = [];
    const emitter = new EventEmitter();
    emitter.on('parameter_warning', (/** @type {any} */ w) => warnings.push(w));
    const session = await makeAgenticSession({ paramsList: ['temperature'], emitter });
    session.withParameters({ params: { cachePoints: { count: 1, type: 'ephemeral' } } });
    assert.equal(/** @type {any} */ (session)._parameters.CACHE_POINTS, undefined, 'the unsupported key is not sent');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].parameter, 'cachePoints', 'the public warning uses the unified name');
    assert.match(warnings[0].message, /cachePoints/);
    assert.doesNotMatch(warnings[0].message, /CACHE_POINTS/);
});
