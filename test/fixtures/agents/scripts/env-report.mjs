/**
 * Fixture: reports the two env keys the allowlist test inspects.
 */
process.stdout.write(JSON.stringify({
    allowed: process.env.MERCI_TEST_ALLOWED ?? null,
    secret: process.env.MERCI_TEST_SECRET ?? null
}));
