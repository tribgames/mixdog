import { register } from 'node:module';

register('./fake-pty-hook.mjs', import.meta.url);
