import { parentPort } from 'worker_threads';
import path from 'path';
import fs from 'fs/promises';
import CancellationTokenSource from './cancel-token';
import { convertBytes } from './utils';

let cancelToken = new CancellationTokenSource();

async function process(fsPathList: string[]) {
    cancelToken.token.onCancellationRequested(() => {
        throw Error('isStop');
    });
    let list = await Promise.all(
        fsPathList.map(async (fsPath) => {
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
}

parentPort?.on('message', (data: string[] | string) => {
    if (typeof data === 'string') {
        if (data === 'stop') {
            cancelToken.cancel();
            cancelToken.dispose();
        }
        return;
    }
    process(data)
        .then((fileInfoList) => {
            parentPort!.postMessage(fileInfoList);
        })
        .catch((err) => {
            throw Error(err);
        });
});
