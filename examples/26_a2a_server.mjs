// @ts-check
/**
 * A2A child agent — spawned by `25_a2a_client.mjs`.
 *
 * Serves one skill from an in-memory ticket table over the **A2A v1.0.0**
 * protocol:
 *   GET  /.well-known/agent-card.json   → the v1.0 agent card
 *   POST /a2a                           → JSON-RPC `SendMessage` / `GetTask` / …
 *
 * The protocol work lives in the SDK (`createA2AServer` + `createA2AHttpHandler`);
 * this example only supplies the skill and mounts it on node:http.
 *
 * Two skills are advertised: `ticket_lookup` answers and ends its task
 * completed, `escalation_request` ends its task in the INTERRUPTED state
 * `input-required` (the SDK reads `outcome.state`), so the parent gets a live
 * task id to read, cancel and read again.
 *
 * stdout carries ONLY the `PORT:<n>` handshake line; all SDK logging goes to
 * stderr via `childLog()`. Kept alive by `process.stdin.resume()` until the
 * parent kills it.
 *
 * @version 0.23.0
 */
import { createServer } from 'node:http';
import { createA2AServer, createA2AHttpHandler } from 'merci-sdk';
import { childLog } from './_shared/example-utils.mjs';

const log = childLog();

const TICKETS = new Map([
    ['T-42', { ticketId: 'T-42', status: 'escalated', owner: 'on-call' }],
    ['T-7', { ticketId: 'T-7', status: 'open', owner: 'billing' }],
]);

const server = createA2AServer({
    name: 'ticket-agent',
    description: 'Looks up support tickets in an in-memory queue.',
    version: '1.0.0',
    skills: [{
        id: 'ticket_lookup',
        name: 'ticket_lookup',
        description: 'Look up a support ticket by id.',
        tags: ['support'],
        examples: ['Look up ticket T-42'],
        inputSchema: {
            type: 'object',
            properties: { ticketId: { type: 'string', description: 'Ticket id, e.g. T-42.' } },
            required: ['ticketId']
        },
        execute:
            /**
             * @param {Record<string, any>} args
             * @returns {Promise<string>}
             */
            async (args) => {
                const ticketId = String(args?.ticketId ?? '');
                const ticket = TICKETS.get(ticketId);
                if (!ticket) throw new Error(`Unknown ticket: ${ticketId || '(empty)'}`);
                log.event({ type: 'ticket.lookup', payload: { ticketId, status: ticket.status } });
                return JSON.stringify(ticket);
            }
    }, {
        id: 'escalation_request',
        name: 'escalation_request',
        description: 'Starts a ticket escalation that a human must decide on — it interrupts the task instead of answering.',
        tags: ['support'],
        examples: ['Escalate ticket T-42'],
        inputSchema: {
            type: 'object',
            properties: { ticketId: { type: 'string', description: 'Ticket id, e.g. T-42.' } },
            required: ['ticketId']
        },
        execute:
            /**
             * @param {{ticketId?: string}} args
             * @returns {Promise<{state: string, text: string}>}
             */
            async ({ ticketId = '' }) => {
                log.event({ type: 'escalation.request', payload: { ticketId } });
                // `state` ends the task in the A2A interrupted state
                // `input-required`: the peer waits for the client instead of
                // completing, and the task keeps its id.
                return { state: 'input-required', text: 'Which queue should own this escalation?' };
            }
    }]
});

const handle = createA2AHttpHandler({ server });

const http = createServer((req, res) => {
    void handle(req, res).catch((err) => {
        console.error(`[a2a-server] request failed: ${err?.message ?? err}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
        }
    });
});

http.listen(0, '127.0.0.1', () => {
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    log.event({ type: 'server.ready', payload: { url: `http://127.0.0.1:${port}` } });
    console.log(`PORT:${port}`);
});

process.stdin.resume();
