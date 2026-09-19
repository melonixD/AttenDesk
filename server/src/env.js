// Load the project .env for local commands; hosting environment values win.
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
const path = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(path)) loadEnvFile(path);
