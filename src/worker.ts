import { parentPort, threadId } from 'worker_threads';
import path from 'path';
import fs from 'fs/promises';
import { CancellationTokenSource } from 'util-kit';
import { convertBytes } from './utils';

let cancelToken = new CancellationTokenSource();

async function process(fsPathList: string[]) {
    try {
        let list = await Promise.all(
            fsPathList.map(async (fsPath) => {
                try {
                    if(cancelToken.token.isCancellationRequested) {return null;}
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
        cancelToken.dispose();
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
            cancelToken = new CancellationTokenSource();
        }
        return;
    }
    cancelToken = new CancellationTokenSource();
    process(data).then((fileInfoList) => {
        parentPort!.postMessage(fileInfoList);
    });
});
