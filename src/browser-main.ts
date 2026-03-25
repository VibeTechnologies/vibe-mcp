#!/usr/bin/env node

import { program } from 'commander';
import { registerStandaloneBrowserCli } from './browser-cli.js';
import { getPackageVersion } from './version.js';

program
  .name('vibebrowser-cli')
  .version(getPackageVersion());

registerStandaloneBrowserCli(program);

program.parse();
