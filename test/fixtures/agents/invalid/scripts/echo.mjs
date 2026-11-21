/**
 * Fixture: a contained script for the definitions that must otherwise be valid.
 */
const payload = JSON.parse(process.argv[2] ?? '{}');
process.stdout.write(JSON.stringify(payload));
