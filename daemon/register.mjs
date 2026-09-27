// Install the @kabelsalat/web alias (see loader.mjs) before anything imports
// @strudel/core.  Usage:  node --import ./register.mjs daemon.mjs
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
