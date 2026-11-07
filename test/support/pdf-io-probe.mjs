// 워커 스레드 사전 적재(`--import`) — 파일 시스템 · 네트워크 진입점을 감싸 부르는 순간 부모에게 `{type:'io'}` 로 알린다.
// 호출은 그대로 통과시킨다(해석기가 실제로 읽으려 하면 동작은 같고 기록만 남는다).
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort } from 'node:worker_threads';

function wrap(target, label, names) {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function probed(...args) {
      parentPort?.postMessage({ type: 'io', call: `${label}.${name}`, arg: typeof args[0] === 'string' ? args[0] : '' });
      return original.apply(this, args);
    };
  }
}

const FS = ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'stat', 'statSync', 'readdir', 'readdirSync', 'access', 'accessSync', 'existsSync'];
wrap(fs, 'fs', FS);
wrap(fsPromises, 'fs/promises', ['open', 'readFile', 'stat', 'readdir', 'access']);
wrap(http, 'http', ['request', 'get']);
wrap(https, 'https', ['request', 'get']);
wrap(net, 'net', ['connect', 'createConnection']);
wrap(globalThis, 'global', ['fetch']);
syncBuiltinESMExports(); // `import { readFile } from 'node:fs'` 형태의 이름 있는 가져오기에도 감싼 함수가 보이게
