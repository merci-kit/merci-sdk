// @ts-check
/**
 * @file Backend media-message factory — per-backend image/PDF user turns.
 * @version 0.12.0
 *
 * @description
 * Shapes an image or PDF plus a prompt into a backend's wire user turn. It
 * lives in the backend layer because it is a per-backend wire concern — the
 * JAI leg delegates to the JAI media factory — so `messaging/`
 * stays free of backend imports (GUIDELINES R4).
 */

import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { ProviderType, StandardType, standardFor, isStandard } from '../core/constants/index.mjs';
import { ConfigurationError } from '../core/errors.mjs';
import { mimeTypeForPath } from '../support/mime.mjs';
import { toBase64DataUrl } from '../support/data-url.mjs';
import { createUserMessage, PDF_MEDIA_PROVIDERS } from '../messaging/messages.mjs';
import { createMediaMessage } from './jai-vendor/messages.mjs';

/**
 * Creates a user turn carrying an image or PDF plus a prompt, per-backend
 * shaped (JAI shapes it natively; GAI/AAI/OAI embed base64
 * data — a PDF becomes an Anthropic `document` block / an OpenAI `file` part).
 * @param {{provider: string, prompt: string, imagePath: string}} arg0
 * @returns {Promise<Array<import('../messaging/unified-message.mjs').MessageRow>>}
 */
export async function createUnifiedMediaMessages({ provider, prompt, imagePath }) {
    const mimeType = mimeTypeForPath({ path: imagePath, fallback: 'image/jpeg' });
    const isPdf = mimeType === 'application/pdf';
    if (isPdf && !PDF_MEDIA_PROVIDERS.has(provider)) {
        throw new ConfigurationError({ message: `PDF media is not supported on the ${provider} provider: only ${[...PDF_MEDIA_PROVIDERS].join(', ')} can inline application/pdf as a media message.`, options: { option: 'pdf_provider_unsupported' } });
    }
    if (provider === ProviderType.JAI) {
        return [
            await createMediaMessage({ source: imagePath }),
            createUserMessage({ provider, content: prompt })
        ];
    }
    const data = await fs.readFile(imagePath);
    const base64Image = data.toString('base64');

    if (isStandard({ provider, standard: StandardType.GAI })) {
        return [{
            role: 'user',
            parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64Image } }
            ]
        }];
    }

    if (provider === ProviderType.ANTHROPIC) {
        const media = isPdf
            ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64Image } }
            : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } };
        return [{
            role: 'user',
            content: [{ type: 'text', text: prompt }, media]
        }];
    }

    const media = (isPdf && standardFor({ provider }) === StandardType.OAI)
        ? { type: 'file', file: { filename: basename(imagePath), file_data: toBase64DataUrl({ mimeType, data: base64Image }) } }
        : { type: 'image_url', image_url: { url: toBase64DataUrl({ mimeType, data: base64Image }) } };
    return [{
        role: 'user',
        content: [{ type: 'text', text: prompt }, media]
    }];
}
