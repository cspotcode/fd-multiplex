#!/usr/bin/env node

import fs from 'fs';
const fd = +process.argv[2];
console.log(`Echoing file descriptor ${ fd }...`);
fs.writeSync(1, fs.readFileSync(fd));
console.log('Done!');