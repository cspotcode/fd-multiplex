#!/usr/bin/env node

import child_process, { StdioOptions, ChildProcess } from 'child_process';
import fs from 'fs';
import assert from 'assert';
import { Writable, Readable } from 'stream';
import {inspect} from 'util';

const doDebug = !!process.env.FD_MULTIPLEX_DEBUG;
if(doDebug) {
    try {
        require('source-map-support').install();
    } catch(e) {}
}

let processId = 'UNSET';
function noop(...args: any[]): any;
function noop() {}
const debug = doDebug ? {
    error(message: string) {
        console.error(`[${ processId }] ${ message }`);
    },
    dir(v: any) {
        console.error(`[${ processId }] ${ inspect(v) }`);
    }
} : {
    error: noop,
    dir: noop
}

async function main() {
    const {isDemuxer, isMuxer, pipedFds: _pipedFds, remainingArgs} = parseArgs();
    if(isDemuxer) {processId = 'DEMUXER'}
    if(isMuxer) {processId = 'MUXER'}

    // stdin, stdout, and stderr are always piped
    const pipedFds = dedupe([..._pipedFds, 0, 1, 2]);

    const allStreams: Array<Writable | Readable> = [];
    const writeStreams: Array<Writable> = [];
    const readStreams: Array<Readable> = [];
    const stdio: StdioOptions = [];
    stdio[2] = 'inherit';

    let childProcess: ChildProcess | undefined;

    if(isMuxer) {
        debug.error('Running multiplexer');
        // our own process's FDs are being connected to the muxer pipe.
        for(const fd of pipedFds) {
            if(fd !== 0) {
                allStreams[fd] = writeStreams[fd] = fs.createWriteStream('', {fd});
            }
            if(fd !== 1 && fd !== 2) {
                const readable = allStreams[fd] = readStreams[fd] = fs.createReadStream('', {fd});
                readable.pause();
            }
        }

        allStreams.forEach((stream, i) => {
            logStreamErrors(stream, i);
        });

        stdio[0] = 'pipe';
        stdio[1] = 'pipe';

        childProcess = spawnChildProcess(remainingArgs, stdio);

        // We only need to open 2 new streams: the mux and demux streams corresponding
        // to child process's stdin and stdout
        const muxer = childProcess.stdio[0];
        const demuxer = childProcess.stdio[1];

        sendDemuxManifest(muxer, pipedFds);
        startPiping({
            allStreams, readStreams, muxer, demuxer
        });
    }

    if(isDemuxer) {
        debug.error('Running demultiplexer');

        // our own process's stdin and stdout are being connected to the muxer pipe.
        const muxer = fs.createWriteStream('', {fd: 1});
        const demuxer = fs.createReadStream('', {fd: 0});

        const pipedFds = await readDemuxManifest(demuxer);

        for(const fd of pipedFds) {
            stdio[fd] = 'pipe';
        }
        childProcess = spawnChildProcess(remainingArgs, stdio);
        debug.dir(childProcess.stdio.map(v => v.constructor.name));

        // Child process is given a full set of file descriptors connected to node streams that we connect to the muxer
        for(const fd of pipedFds) {
            const fdStream = allStreams[fd] = childProcess.stdio[fd];
            if(fd !== 1 && fd !== 2) {
                writeStreams[fd] = fdStream as Writable;
            }
            if(fd !== 0) {
                readStreams[fd] = fdStream as Readable;
                (fdStream as Readable).pause();
            }
        }
        startPiping({allStreams, readStreams, muxer, demuxer});
    }

    function startPiping(opts: {allStreams: Array<Readable | Writable>, readStreams: Array<Readable>, muxer: Writable, demuxer: Readable}) {
        const {allStreams, demuxer, muxer, readStreams} = opts;
        allStreams.forEach((stream, i) => {
            logStreamErrors(stream, i);
        });
        readStreams.forEach((stream, fd) => {
            pipeReadableToMuxer(stream, muxer, fd);
        });
        demultiplex(demuxer, allStreams).catch(e => {
            debug.error(`Demultiplexer error: ${ e }`);
        });
        (async () => {
            await Promise.all(readStreams.map((stream) => streamIsEnded(stream)));
            muxer.end();
        })();
    }

    childProcess!.once('close', code => {
        if(typeof code === 'number') process.exit(code);
        process.exit(1);
        // TODO what about when terminated via a signal???
    });
}

function spawnChildProcess(remainingArgs: Array<string>, stdio: StdioOptions) {
    const [bin, ...args] = remainingArgs;
    debug.error(`Spawning child process: ${ bin }`);
    debug.error(`passing arguments: ${ JSON.stringify(args) }`);
    const childProcess = child_process.spawn(bin, args, {
        stdio
    });
    return childProcess;
}

function parseArgs() {
    const args = process.argv.slice(2);

    const multiplexedFds: Array<number> = [];
    const demultiplexedFds: Array<number> = [];

    let i = 0;
    while(true) {
        const arg = args[i];
        if(arg == '--') { i++; break; }
        const match = arg.match(/^(?:\-(.)|\-\-([^=]+))(?:=(.*)|)$/);
        function grabValue() {
            if(!value) { value =  args[++i]; }
        }
        if(!match) throw new Error('unexpected flag: ' + arg);
        let [_t, abbreviation, key, value] = match!;
        switch(abbreviation) {
            case 'm':
                key = 'multiplex';
                grabValue();
                break;
            case 'd':
                key = 'demultiplex';
                grabValue();
                break;
            default:
                throw new Error('Unrecognized flag: -' + abbreviation);
        }
        switch(key) {
            case 'multiplex':
                multiplexedFds.push(...value.split(',').map(v => parseInt(v.trim())));
                break;
            case 'demultiplex':
                demultiplexedFds.push(...value.split(',').map(v => parseInt(v.trim())));
                break;
            default:
                throw new Error('Unrecognized flag: --' + key);
        }
        i++;
    }
    const remainingArgs = args.slice(i);
    const isMuxer = !!multiplexedFds.length;
    const isDemuxer = !isMuxer;
    assert(isMuxer !== isDemuxer);
    const pipedFds = [...multiplexedFds, ...demultiplexedFds];
    for(const fd of pipedFds) {
        assert(fd >= 0);
        assert(fd <= 255);
    }
    return {pipedFds, isDemuxer, isMuxer, remainingArgs};
}

/** Read data from a FD and send it all as packets to a muxer stream */
async function pipeReadableToMuxer(source: Readable, muxerTarget: Writable, targetFd: number) {
    let done = false;
    source.on('end', () => {
        debug.error(`Sending close packet for ${ targetFd }`);
        muxerTarget.write(createClosePacket(targetFd));
        done = true;
    });
    while(!done) {
        const data: Buffer | null = source.read();
        if(data) {
            for(let i = 0; i < data.length; i += 255) {
                const chunk = data.slice(i, 255);
                debug.error(`Sending write packet for ${ targetFd } of length ${ chunk.length }: ${ chunk.toString('utf8') }`);
                muxerTarget.write(createWritePacket(targetFd, chunk));
            }
        } else {
            await streamIsReadable(source);
        }
    }
}

function createWritePacket(targetFd: number, data: Buffer): Buffer {
    const packet = new Buffer(data.length + 3);
    packet[0] = targetFd;
    packet[1] = PacketAction.write;
    packet[2] = data.length;
    data!.copy(packet, 3, 0, data.length);
    return packet;
}
function createClosePacket(targetFd: number): Buffer {
    return Buffer.from([targetFd, PacketAction.close, 0]);
}

/**
 * Send the first packet to a muxer stream: the set of FDs being multiplexed.
 * Demuxer needs to know this ahead of time because it needs to open the FDs
 * when spawning child process.
 */
async function sendDemuxManifest(writeStream: Writable, fds: Array<number>) {
    const b = new Buffer(fds.length + 1);
    b[0] = fds.length;
    Buffer.from(fds).copy(b, 1, 0, fds.length);
    writeStream.write(b);
}

/** Read the first packet off of a demux stream: the set of FDs being multiplexed */
async function readDemuxManifest(readable: Readable): Promise<Array<number>> {
    const b = new Buffer(1);
    await readExactlyXBytes(readable, 1, b);
    const b2 = await readExactlyXBytes(readable, b[0]);
    return Array.from(b2);
}

enum PacketAction {
    write = 0,
    close = 1,
}

/** Read inputFd as a demux stream.  Send packets to the appropriate targets. */
async function demultiplex(input: Readable, streams: Array<Writable | Readable | fs.ReadStream>) {
    const targetLengthBuffer = new Buffer(3);
    function target() {return targetLengthBuffer[0];}
    function action(): PacketAction {return targetLengthBuffer[1];}
    function length() {return targetLengthBuffer[2];}
    // const dataBuffer = new Buffer(256);
    while(true) {
        await readExactlyXBytes(input, 3, targetLengthBuffer);
        switch(action()) {
            case PacketAction.write:
                const data = await readExactlyXBytes(input, length());
                debug.error(`Received write packet for ${ target() } of length ${ length() }: ${ data.toString('utf8') }`);
                debug.error(`Forwarding packet of length ${ length() } to fd ${ target() }`)
                const wStream = streams[target()] as Writable;
                assert(wStream, `streams[${ target() }] does not exist`);
                wStream.write(data);
                break;
            case PacketAction.close:
                const _target = target();
                debug.error(`Received close packet for ${ _target }`);
                const cStream = streams[_target];
                assert(cStream, `streams[${ _target }] does not exist`);
                if(cStream instanceof Writable) {
                    cStream.end(() => {
                        debug.error(`Successfully closed ${ _target }`);
                    });
                } else if(cStream instanceof fs.ReadStream) {
                    cStream.close();
                } else {
                    assert(false, `This should never happen!`);
                }
        }
    }
}

/** Read x bytes from a stream; no more, no less.  If not passed an input buffer, allocates one of exactly the right length. */
async function readExactlyXBytes(input: Readable, bytes: number, buffer: Buffer = new Buffer(bytes)): Promise<Buffer> {
    let offset = 0;
    let remaining = bytes;
    while(remaining) {
        const data: Buffer = input.read(remaining);
        if(data) {
            const bytesRead = data.length;
            data.copy(buffer, offset, 0, bytesRead);
            remaining -= bytesRead;
            offset += bytesRead;
        } else {
            await streamIsReadable(input);
        }
    }
    return buffer;
}

/** Wait for a paused stream to become readable */
function streamIsReadable(input: Readable) {
    return new Promise(res => {
        input.once('readable', () => res());
    });
}

function streamIsEnded(input: Readable) {
    return new Promise(res => {
        input.on('end', () => res());
    });
}

function logStreamErrors(stream: Readable | Writable, fd: number | string = 'unknown') {
    stream.on('error', (err) => {
        debug.error(`Error from file descriptor ${ fd }: ${ err }`);
    });
}

function dedupe(input: Array<any>) {
    const s = new Set();
    input.forEach(v => {
        s.add(v);
    });
    return Array.from(s);
}

main().catch(e => {
    console.error(e.stack);
    process.exit(1);
});