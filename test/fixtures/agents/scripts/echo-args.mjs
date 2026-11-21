/**
 * Fixture: prints the JSON argv back, so a test can assert what reached the child.
 */
const payload = JSON.parse(process.argv[2] ?? '{}');
process.stdout.write(JSON.stringify(payload));
