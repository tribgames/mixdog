// The lifeline's watcher (daemon-supervisor-link.mjs): the supervisor is the
// only writer of this pipe, so its end means the supervisor is gone. Read on
// this worker's own loop, it is seen while the main thread is frozen; SIGKILL
// ends the whole process without waiting on that thread.
import net from 'node:net';
import { workerData } from 'node:worker_threads';

const lifeline = new net.Socket({ fd: workerData.fd, readable: true, writable: false });
const gone = () => process.kill(process.pid, 'SIGKILL');
lifeline.on('end', gone);
lifeline.on('close', gone);
lifeline.on('error', gone);
lifeline.resume();
