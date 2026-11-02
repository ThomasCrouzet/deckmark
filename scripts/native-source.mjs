import { resolve } from 'node:path';
import { testSource } from './test-source.mjs';

if (!process.argv[2]) throw new Error('Supply a native source evidence directory');
testSource(resolve(process.argv[2]));
