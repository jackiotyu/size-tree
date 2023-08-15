import { Worker } from 'worker_threads';
import os from 'os';

const cpusLength = os.cpus().length;

interface WorkerIndex {
    [x: number]: Worker;
}
interface ActiveWorkerIndex {
    [x: number]: boolean;
}
interface Task {
    cb: Function;
    data: any;
}

export class WorkerPool {
    private workerPath: string;
    private numberOfThreads: number;
    // 任务队列
    private _queue: Task[] = [];
    // worker 索引
    private _workersById: WorkerIndex = {};
    // worker 激活状态索引
    private _activeWorkersById: ActiveWorkerIndex = {};
    constructor(workerPath: string, numberOfThreads = cpusLength) {
        if (numberOfThreads < 1) {
            throw new Error('Number of threads should be greater or equal than 1!');
        }
        this.workerPath = workerPath;
        this.numberOfThreads = numberOfThreads;

        this.initWorker();
    }

    initWorker() {
        for (let i = 0; i < this.numberOfThreads; i++) {
            const worker = new Worker(this.workerPath);
            this._workersById[i] = worker;
            // 将这些 worker 设置为未激活状态
            this._activeWorkersById[i] = false;
        }
    }

    private getInactiveWorkerId() {
        for (let i = 0; i < this.numberOfThreads; i++) {
            if (!this._activeWorkersById[i]) {
                return i;
            }
        }
        return -1;
    }

    private doAfterTaskIsFinished(worker: Worker, workerId: number) {
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        this._activeWorkersById[workerId] = false;
        if (this._queue.length) {
            this.runWorker(workerId, this._queue.shift() as Task);
        }
    }

    private runWorker(workerId: number, taskObj: Task) {
        const worker = this._workersById[workerId];
        this._activeWorkersById[workerId] = true;
        const messageCallback = (result: any) => {
            taskObj.cb(null, result);
            this.doAfterTaskIsFinished(worker, workerId);
        };
        const errorCallback = (error: any) => {
            console.log('errorCallback', error);
            taskObj.cb(error);
            this.doAfterTaskIsFinished(worker, workerId);
        };
        worker.once('message', messageCallback);
        worker.once('error', errorCallback);
        worker.postMessage(taskObj.data);
    }

    run<T, R>(data: T) {
        return new Promise<R>((resolve, reject) => {
            const availableWorkerId = this.getInactiveWorkerId();
            const taskObj: Task = {
                data,
                cb: (error: any, result: any) => {
                    if (error) {
                        reject(error);
                    }
                    return resolve(result);
                },
            };
            if (availableWorkerId === -1) {
                // 当前没有空闲的 Workers 了，把任务丢进队列里，这样一旦有 Workers 空闲时就会开始执行。
                this._queue.push(taskObj);
                return null;
            }
            // 有一个空闲的 Worker，用它执行任务
            this.runWorker(availableWorkerId, taskObj);
        });
    }
    stop() {
        for (let i = 0; i < this.numberOfThreads; i++) {
            // Worker中断任务
            this._workersById[i].postMessage('stop');
        }
    }
    // 销毁所有worker
    destroy(force = false) {
        for (let i = 0; i < this.numberOfThreads; i++) {
            if (this._activeWorkersById[i] && !force) {
                // 通常情况下，不应该在还有 Worker 在执行的时候就销毁它，
                // 这一定是什么地方出了问题，所以还是抛个 Error 比较好
                // 不过保留一个 force 参数，总有人用得到的
                throw new Error(`The worker ${i} is still running!`);
            }
            // 销毁这个 Worker
            this._workersById[i].terminate();
        }
    }
}
