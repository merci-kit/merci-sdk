#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.TYPECHECK !== '1' && process.env.TYPECHECK !== 'true') process.exit(0);

const local = process.platform === 'win32' ? 'node_modules/.bin/tsc.cmd' : 'node_modules/.bin/tsc';
execFileSync(existsSync(local) ? local : 'tsc', ['--noEmit'], { stdio: 'inherit' });
