// Preloaded into the second process of a recording that needs two processes (node --import <this file>): the same determinism as
// determinism-preload.mjs, and a pid of its own (4243) so the two are different processes to the code under test.
import './determinism-preload.mjs';

Object.defineProperty(process, 'pid', { value: 4243, configurable: true });
