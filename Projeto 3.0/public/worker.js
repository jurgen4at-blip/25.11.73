debugger
const { parentPort, workerData } = require('worker_threads');
parentPort.postMessage("X".repeat(workerData));