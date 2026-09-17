// Generated from the reviewed NCAA catalog. Run from any working directory.
import { run } from '../../src/cli.mjs';
await run([...["--conference","west-coast"], ...process.argv.slice(2)]);
