// @ts-check
/**
 * @file Vendor error factory tests for the shared fetch transport.
 * @version 0.22.0
 *
 * @description
 * The Anthropic (`@anthropic-ai/sdk@1.5.0`) and Google (`@google/genai@2.32.0`)
 * error surfaces: message forms, own properties, the request-id header each
 * reads, and the fields neither carries. The OpenAI shape stays covered by
 * `transport-http.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApiError, createAnthropicApiError, createGoogleApiError } from '../lib/backends/transport/errors.mjs';

/** @param {Record<string, unknown>} [details] */
const anthropicBody = (details) => ({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'bad request', ...(details ? { details } : {}) },
});

test('errors: buildApiError keeps the OpenAI own-property shape', () => {
    const error = buildApiError({ status: 400, errorField: { message: 'bad', code: 'c', type: 't', param: 'p' } });
    assert.equal(error.message, '400 bad');
    assert.equal(error.status, 400);
    assert.equal(error.code, 'c');
    assert.equal(error.param, 'p');
});

test('errors: Anthropic matches the SDK message and own properties', () => {
    const headers = new Headers({ 'request-id': 'req_1', 'x-request-id': 'ignored' });
    const body = {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad request', details: { error_code: 'invalid_api_key', hint: 'x' } },
    };
    const error = /** @type {any} */ (createAnthropicApiError({ status: 400, headers, body }));
    assert.deepEqual(
        Object.keys(error),
        ['status', 'headers', 'requestID', 'error', 'apiMessage', 'type', 'errorCode', 'details'],
    );
    assert.equal(error.name, 'Error');
    assert.equal(error.message, `400 ${JSON.stringify(body)}`, 'the whole body is the message when it has no top-level message');
    assert.equal(error.status, 400);
    assert.equal(error.headers, headers);
    assert.equal(error.requestID, 'req_1', 'request-id, not x-request-id');
    assert.equal(error.error, body);
    assert.equal(error.apiMessage, 'bad request');
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.errorCode, 'invalid_api_key');
    assert.deepEqual(error.details, { error_code: 'invalid_api_key', hint: 'x' });
    assert.equal(error.code, undefined, 'Anthropic has no code');
    assert.equal(error.param, undefined, 'Anthropic has no param');
});

test('errors: Anthropic message forms follow the SDK', () => {
    assert.equal(createAnthropicApiError({ status: 400, body: { message: 'top level' } }).message, '400 top level');
    assert.equal(createAnthropicApiError({ status: 500, text: 'upstream down' }).message, '500 upstream down');
    assert.equal(createAnthropicApiError({ status: 500 }).message, '500 status code (no body)');
    assert.equal(createAnthropicApiError({ status: 500, text: '' }).message, '500 status code (no body)');
});

test('errors: Anthropic reads only request-id and defaults the optional fields', () => {
    const error = createAnthropicApiError({ status: 400, headers: new Headers({ 'x-request-id': 'xreq' }), body: { message: 'x' } });
    assert.equal(error.requestID, null, 'x-request-id is not the Anthropic header');
    assert.equal(error.apiMessage, null);
    assert.equal(error.type, null);
    assert.equal(error.errorCode, null);
    assert.equal(error.details, null);
});

test('errors: Anthropic keeps an explicit type and a non-string error_code out', () => {
    const override = createAnthropicApiError({ status: 400, body: anthropicBody(), type: 'override' });
    assert.equal(override.type, 'override');
    const numericCode = createAnthropicApiError({ status: 400, body: anthropicBody({ error_code: 42 }) });
    assert.equal(numericCode.errorCode, null, 'only a string error_code is surfaced');
    assert.deepEqual(numericCode.details, { error_code: 42 });
});

test('errors: Google matches the SDK message and own properties', () => {
    const body = { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } };
    const error = /** @type {any} */ (createGoogleApiError({ status: 400, body }));
    assert.equal(error.name, 'ApiError');
    assert.equal(error.status, 400);
    assert.equal(error.message, JSON.stringify(body));
    assert.deepEqual(Object.keys(error), ['name', 'status']);
    assert.equal(error.code, undefined, 'Google has no code property');
    assert.equal(error.headers, undefined, 'Google has no headers property');
});

test('errors: Google synthesizes the SDK error body from plain text', () => {
    const error = createGoogleApiError({ status: 403, text: 'forbidden' });
    assert.equal(error.message, JSON.stringify({ error: { message: 'forbidden', code: 403, status: 'Forbidden' } }));
    const custom = createGoogleApiError({ status: 403, statusText: 'Nope', text: 'forbidden' });
    assert.equal(custom.message, JSON.stringify({ error: { message: 'forbidden', code: 403, status: 'Nope' } }));
});
