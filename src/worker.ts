import { parentPort } from 'worker_threads';
import path from 'path';
import fs from 'fs/promises';
import CancellationTokenSource from './cancel-token';
import { convertBytes } from './utils';

let cancelToken = new CancellationTokenSource();

async function processList(fsPathList: string[]) {
    try {
        let stop = false;
        cancelToken.token.onCancellationRequested(() => {
            stop = true;
        });
        let list = await Promise.all(
            fsPathList.map(async (fsPath) => {
                if (stop) {
                    throw Error('isStop');
                }
                try {
                    let { size } = await fs.stat(fsPath);
                    let filename = path.basename(fsPath);
                    return {
                        filename,
                        size,
                        fsPath,
                        humanReadableSize: convertBytes(size),
                    };
                } catch (err) {
                    console.log(err, 'err');
                    return null;
                }
            }),
        );
        cancelToken.dispose();
        return list.filter((i) => i !== null);
    } catch {
        return [];
    }
}

parentPort?.on('message', (data: string[] | string) => {
    if (typeof data === 'string') {
        if (data === 'stop') {
            try {
                cancelToken.cancel();
                cancelToken.dispose();
            } catch {}
        }
        return;
    }
    processList(data)
        .then((fileInfoList) => {
            parentPort!.postMessage(fileInfoList);
        })
        .catch((err) => {
            parentPort!.postMessage([]);
        });
});

process.on('unhandledRejection', () => parentPort!.postMessage([]));
process.on('uncaughtException', () => parentPort!.postMessage([]));
