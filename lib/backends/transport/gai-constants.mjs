// @ts-check
/**
 * @file The Gemini tool-config enum the GAI adapter emits.
 * @version 0.22.0
 *
 * @description
 * `@google/genai@2.32.0` exported this as a runtime const; the adapter only
 * needs the four wire values, so the package is no longer a dependency.
 */

/** The `toolConfig.functionCallingConfig.mode` values Gemini accepts. */
export const FunctionCallingConfigMode = Object.freeze({
    MODE_UNSPECIFIED: 'MODE_UNSPECIFIED',
    AUTO: 'AUTO',
    ANY: 'ANY',
    NONE: 'NONE',
    VALIDATED: 'VALIDATED',
});
