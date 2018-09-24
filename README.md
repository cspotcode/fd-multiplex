# fd-multiplex

## What?

A utility for piping many file descriptors over a single stdin & stdout pair, to support remoting tools that do not
forward extra file descriptors, such as `docker exec`.  Effectively , you can launch a process on
a remote system and pipe data on many file descriptors.  These are sometimes used as IPC channels.

## Why?

Here's the exact situation that motivated this utility:

A mocha test runner spawns a worker process using node's `child_process.fork()`, which establishes an IPC channel with the child process
via an extra file descriptor.  The problem is, I need to run my tests within a docker container, and `docker exec` only pipes stdin,
stdout, and stderr.  So I need a way to `child_process.fork()` a node process within a docker container.  I need a tool that
pipes many file descriptors over stdin and stdout.

In a more general sense, it seemed strange to me that such a utility didn't already exist.

## How?

Two processes are involved: the multiplexer and the demultiplexer.  The multiplexer spawns the demultiplexer directly or indirectly. (for example, via `docker exec`)
The demultiplexer spawn the program you want to run.  (for example, `mocha`)

Both multiplexer and demultiplexer talk to each other via a single stdin / stdout pair.  All data read by the multiplexer from its
file descriptors (stdin, stdout, fd3, etc) are
encoded as packets and sent to the demultiplexer, which writes the data to the target process's matching file descriptor.
The same happens in reverse.  The calling process and target process are (hopefully) none the wiser.

## Usage

Pass `-m` or `--multiplex` to the multiplexer side of the pipe.  Don't pass any options to the other side and it will assume demultiplexer mode.

Prefix the command to launch with `--`.

For example, to create a shim of `targetBinary` that runs it in a remote docker container and forwards file descriptor 3:

```
#!/bin/bash
fd-multiplex -m 3 -- docker-compose exec my-container fd-multiplex -- targetBinary
```
