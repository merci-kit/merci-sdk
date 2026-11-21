// Ambient declarations for dependencies that ship no TypeScript types.
// Keep this file small and precise: every entry is a real module used by the SDK.

declare module '@freakynit/json-healer' {
    const JsonHealer: {
        /** Repairs malformed JSON text. */
        parse(input: string, options?: Record<string, any>): any;
    };
    export default JsonHealer;
}
