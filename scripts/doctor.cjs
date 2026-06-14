#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const os = require('os');

function run(cmd, args) {
  try {
    const out = childProcess.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim();
  } catch (err) {
    return null;
  }
}

const nodeVersion = process.version;
const npmVersion = run('npm', ['--version']);
const pythonVersion = run('python3', ['--version']) || run('python', ['--version']);
const makeVersion = run('make', ['--version']);
const gppVersion = run(process.platform === 'win32' ? 'cl' : 'g++', ['--version']);

console.log('Anaglysh doctor');
console.log('----------------');
console.log(`platform : ${os.platform()} ${os.release()} ${os.arch()}`);
console.log(`node     : ${nodeVersion}`);
console.log(`npm      : ${npmVersion || 'missing'}`);
console.log(`python   : ${pythonVersion || 'missing; node-pty may fail to build'}`);
console.log(`make     : ${makeVersion ? 'present' : 'missing; node-pty may fail to build'}`);
console.log(`${process.platform === 'win32' ? 'cl' : 'g++'}      : ${gppVersion ? 'present' : 'missing; node-pty may fail to build'}`);
console.log('');
console.log('If npm install fails on Linux, install build-essential, python3, and make.');
console.log('If it fails on Windows, install Visual Studio Build Tools with C++ workload.');
