// 탐침 대조군 — 감싼 fs 를 한 번 부르고 끝낸다.
import { existsSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

existsSync('/');
parentPort?.postMessage({ type: 'end' });
