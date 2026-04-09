#!/usr/bin/env node

import { program } from 'commander';
import { registerStandaloneBrowserCli } from './browser-cli.js';
import { getPackageVersion } from './version.js';

program
  .name('vibebrowser-cli')
  .description('OpenClaw-compatible browser CLI (relay mode by default, or chrome-devtools with --devtools)')
  .version(getPackageVersion());

registerStandaloneBrowserCli(program);

program.parse();
