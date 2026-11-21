// @ts-check
/**
 * @file Wire-standard registry.
 * @version 0.12.0
 *
 * @description
 * One descriptor per wire standard (OAI / AAI / GAI / JAI): the protocol
 * superset in preference order, the protocols that are transport surfaces
 * rather than session protocols, and whether the standard carries a
 * prompt-cache slot. Data only — `sdk.mjs` derives `TRANSPORT_PROTOCOLS` and
 * the Google-family predicate from it. The protocol strings mirror
 * `ProtocolType` in ./sdk.mjs; importing that module here would create a
 * cycle, and test/provider-registry.test.mjs locks the literals to it.
 */


/**
 * Every wire standard the SDK speaks.
 * @type {Object<string, string>}
 */
export const StandardType = Object.freeze({
    OAI: 'oai',
    AAI: 'aai',
    GAI: 'gai',
    JAI: 'jai',
});


/**
 * @typedef {Object} StandardDescriptor
 * @property {string} id - The StandardType value.
 * @property {Array<string>} protocols - Protocol superset, preference order.
 * @property {Array<string>} transportProtocols - Protocols that are transport
 *   surfaces, not sessions (JAI `task` only).
 * @property {boolean} promptCache - The standard has a prompt-cache wire slot.
 */


/**
 * Descriptors keyed by StandardType value.
 * @type {Object<string, StandardDescriptor>}
 */
export const STANDARDS = Object.freeze({
    [StandardType.OAI]: {
        id: StandardType.OAI,
        protocols: ['completions', 'responses'],
        transportProtocols: [],
        promptCache: false,
    },
    [StandardType.AAI]: {
        id: StandardType.AAI,
        protocols: ['messages'],
        transportProtocols: [],
        promptCache: true,
    },
    [StandardType.GAI]: {
        id: StandardType.GAI,
        protocols: ['generateContent'],
        transportProtocols: [],
        promptCache: false,
    },
    [StandardType.JAI]: {
        id: StandardType.JAI,
        protocols: ['chat', 'responses', 'task'],
        transportProtocols: ['task'],
        promptCache: false,
    },
});


/**
 * @param {{standard?: string}} [arg0] - StandardType value.
 * @returns {StandardDescriptor|null} The descriptor, or null for an unknown standard.
 */
export function standardDescriptorFor({ standard } = {}) {
    return typeof standard === 'string' ? STANDARDS[standard] ?? null : null;
}
