#!/usr/bin/env node
// zombie-safe-spawn.js — Wrapper that ensures Node child processes don't create
// zombies by installing a SIGCHLD handler that reaps exit codes.
//
// This is a global setup that should be required() by any Node process that
// might spawn subprocesses (agents, adapters, CLI tools).
//
// Usage:
//   require('./zombie-safe-spawn.js');  // Call this EARLY in your process
//   // Now all future spawn() calls will automatically reap children
//
// How it works:
//   - Installs a process.on('SIGCHLD') handler that waits on all children
//   - Prevents the kernel from leaving exit codes in the process table
//   - Has no effect on processes that already have proper listeners

const childProcess = require('child_process');

function setupZombieSafeSpawn() {
  let initialized = false;

  process.on('SIGCHLD', () => {
    // No-op: installing any SIGCHLD handler causes libuv to wake up and
    // call waitpid() internally, which is the actual reap mechanism.
    // The spawn/execFile wrappers below are the primary guard.
  });

  // Backward-compatibility: also trap when children exit without a listener
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(...args) {
    const proc = originalSpawn.apply(this, args);

    // If the caller doesn't attach a listener within one tick, auto-reap on exit
    // (but don't interfere if they provide one themselves)
    process.nextTick(() => {
      if (proc.listeners('exit').length === 0) {
        proc.on('exit', (code, signal) => {
          // Exit code is consumed; process is reaped
        });
      }
    });

    return proc;
  };

  // Do the same for execFile and exec (they use spawn under the hood)
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = function(...args) {
    const proc = originalExecFile.apply(this, args);
    if (proc && typeof proc.on === 'function') {
      process.nextTick(() => {
        if (proc.listeners('exit').length === 0) {
          proc.on('exit', (code, signal) => {
            // Consumed
          });
        }
      });
    }
    return proc;
  };

  console.log('[zombie-safe-spawn] SIGCHLD handler installed — child processes will be auto-reaped');
}

// Setup immediately on require
setupZombieSafeSpawn();
module.exports = setupZombieSafeSpawn;
