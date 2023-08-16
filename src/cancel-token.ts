import { EventEmitter } from 'events';

const CANCEL = Symbol();
const RESET = Symbol();

class CancellationToken extends EventEmitter {
    cancelled: boolean;
    constructor() {
        super({
            captureRejections: false,
        });
        this.cancelled = false;
        this.setMaxListeners(100);
    }
    throwIfCancelled() {
        if (this.isCancelled()) {
            throw Error('Cancelled!');
        }
    }
    get isCancellationRequested() {
        return this.isCancelled();
    }
    onCancellationRequested(cb: (...args: any[]) => void) {
        this.once('cancel', cb);
    }
    [RESET]() {
        this.cancelled = false;
    }
    isCancelled() {
        return this.cancelled === true;
    }
    [CANCEL]() {
        this.cancelled = true;
        this.emit('cancel');
    }
    dispose() {
        this.removeAllListeners();
        this.cancelled = false;
    }
}

export default class CancellationTokenSource {
    token: CancellationToken;
    constructor() {
        this.token = new CancellationToken();
    }
    reset() {
        this.token[RESET]();
    }
    cancel() {
        this.token[CANCEL]();
    }
    dispose() {
        this.token.dispose();
    }
}
