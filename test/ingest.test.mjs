// @ts-check

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument, DOCUMENT_INGEST_SYSTEM_PROMPT } from '../lib/agentic/ingest.mjs';
import { ConfigurationError } from '../lib/core/errors.mjs';
import { ProviderType } from '../lib/core/constants/providers.mjs';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {{provider: any, captured: Record<string, any>}} arg0 */
function fakeClient({ provider, captured }) {
    return {
        provider,
        session() {
            return {
                withSystemMessage(/** @type {any} */ system) {
                    captured.system = system;
                    return this;
                },
                /** @param {{messages: any[], options: any}} arg0 */
                async *step({ messages, options }) {
                    captured.messages = messages;
                    captured.options = options;
                    yield { type: 'text', content: '# Title' };
                },
            };
        },
    };
}

describe('ingestDocument', () => {
    /** @type {string} */
    let dir;
    /** @type {string} */
    let png;
    /** @type {string} */
    let pdf;

    before(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'merci-ingest-'));
        png = join(dir, 'page.png');
        pdf = join(dir, 'doc.pdf');
        await fs.writeFile(png, PNG_BYTES);
        await fs.writeFile(pdf, Buffer.from('%PDF-1.4'));
    });

    after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('routes an image through the model and returns Markdown', async () => {
        /** @type {Record<string, any>} */ const captured = {};
        const md = await ingestDocument({ client: fakeClient({ provider: ProviderType.OPENAI, captured }), model: 'm', path: png });
        assert.equal(md, '# Title');
        assert.equal(captured.system, DOCUMENT_INGEST_SYSTEM_PROMPT);
        const url = captured.messages[0].content[1].image_url.url;
        assert.ok(url.startsWith('data:image/png;base64,'));
        assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('binary'), PNG_BYTES.toString('binary'));
    });

    it('rejects a PDF on backends that cannot inline it, with a clear error', async () => {
        for (const provider of [ProviderType.LOCAL, ProviderType.OPENCODE]) {
            const client = fakeClient({ provider, captured: {} });
            await assert.rejects(
                () => ingestDocument({ client, model: 'm', path: pdf }),
                (err) => err instanceof ConfigurationError && err.message.includes(`not supported on the ${provider} provider`)
            );
        }
    });

    it('shapes a PDF as Gemini inlineData on Google GenAI and Vertex', async () => {
        for (const provider of [ProviderType.GOOGLE_GENAI, ProviderType.VERTEX]) {
            /** @type {Record<string, any>} */ const captured = {};
            const client = fakeClient({ provider, captured });
            const md = await ingestDocument({ client, model: 'm', path: pdf });
            assert.equal(md, '# Title');
            assert.equal(captured.messages[0].parts[1].inlineData.mimeType, 'application/pdf');
        }
    });

    it('shapes a PDF as an Anthropic document block', async () => {
        /** @type {Record<string, any>} */ const captured = {};
        const client = fakeClient({ provider: ProviderType.ANTHROPIC, captured });
        const md = await ingestDocument({ client, model: 'm', path: pdf });
        assert.equal(md, '# Title');
        const block = captured.messages[0].content[1];
        assert.equal(block.type, 'document');
        assert.equal(block.source.type, 'base64');
        assert.equal(block.source.media_type, 'application/pdf');
        assert.equal(Buffer.from(block.source.data, 'base64').toString(), '%PDF-1.4');
    });

    it('shapes a PDF as an OpenAI file part', async () => {
        /** @type {Record<string, any>} */ const captured = {};
        const client = fakeClient({ provider: ProviderType.OPENAI, captured });
        const md = await ingestDocument({ client, model: 'm', path: pdf });
        assert.equal(md, '# Title');
        const part = captured.messages[0].content[1];
        assert.equal(part.type, 'file');
        assert.equal(part.file.filename, 'doc.pdf');
        assert.ok(part.file.file_data.startsWith('data:application/pdf;base64,'));
    });

    it('rejects an unsupported extension', async () => {
        const client = fakeClient({ provider: ProviderType.OPENAI, captured: {} });
        await assert.rejects(
            () => ingestDocument({ client, model: 'm', path: join(dir, 'notes.txt') }),
            ConfigurationError
        );
    });

    it('refuses a path outside the supplied root and accepts one inside', async () => {
        const client = fakeClient({ provider: ProviderType.OPENAI, captured: {} });
        const root = join(dir, 'docs');
        await fs.mkdir(root, { recursive: true });
        const inside = join(root, 'page.png');
        await fs.writeFile(inside, PNG_BYTES);
        /** @param {string} option */
        const refused = (option) => (/** @type {any} */ err) => err instanceof ConfigurationError && err.option === option;

        await assert.rejects(() => ingestDocument({ client, model: 'm', path: png, root }), refused('path'));
        assert.equal(await ingestDocument({ client, model: 'm', path: inside, root }), '# Title');
        assert.equal(await ingestDocument({ client, model: 'm', path: 'page.png', root }), '# Title', 'a relative path resolves against root');
        assert.equal(await ingestDocument({ client, model: 'm', path: png, root: '' }), '# Title', 'an empty root means no root');
    });

    it('reads the root-relative target, never a bare path resolved against cwd', async () => {
        const client = fakeClient({ provider: ProviderType.OPENAI, captured: {} });
        const root = join(dir, 'docs-only');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(join(dir, 'only-in-cwd.png'), PNG_BYTES);

        await assert.rejects(
            () => ingestDocument({ client, model: 'm', path: 'only-in-cwd.png', root }),
            (/** @type {any} */ err) => err instanceof ConfigurationError && err.option === 'path'
        );
    });

    it('refuses a symlink inside the root that points outside it', async () => {
        const client = fakeClient({ provider: ProviderType.OPENAI, captured: {} });
        const root = join(dir, 'docs-linked');
        await fs.mkdir(root, { recursive: true });
        const outside = join(dir, 'outside-page.png');
        await fs.writeFile(outside, PNG_BYTES);
        await fs.symlink(outside, join(root, 'linked.png'));

        await assert.rejects(
            () => ingestDocument({ client, model: 'm', path: 'linked.png', root }),
            (/** @type {any} */ err) => err instanceof ConfigurationError && err.option === 'path'
        );
    });

    it('requires an initialized client and a path', async () => {
        await assert.rejects(() => ingestDocument({ model: 'm', path: png }), ConfigurationError);
        await assert.rejects(() => ingestDocument({ client: fakeClient({ provider: ProviderType.OPENAI, captured: {} }) }), ConfigurationError);
    });
});
