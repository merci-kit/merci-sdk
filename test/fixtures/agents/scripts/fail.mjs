/**
 * Fixture: fails with a diagnostic on stderr, for the non-zero-exit path.
 */
process.stderr.write('fixture boom\n');
process.exit(3);
