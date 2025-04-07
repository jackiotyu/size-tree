interface SiblingClause {
	when: string;
}

export interface IExpression {
	[pattern: string]: boolean | SiblingClause;
}

export function resolvePatterns(...globalPatterns: (IExpression | undefined)[]): string[] {
	const merged = globalPatterns.reduce((map, obj = {}) => ({...map, ...obj}), {}) || {};
	return Object.keys(merged)
		.filter(key => {
			const value = merged[key];
			return typeof value === 'boolean' && value;
		});
}

/** 数组切分分组 */
export function chunkList(list: any[], num: number){
	let splitNum = num < 1 ? 1 : num;
	let copyList = [...list];
	let res = [];
	let count = 0;
	while(copyList.length && count < list.length) {
		count++;
		res.push(copyList.splice(0, splitNum));
	}
	return res;
}

export const convertBytes = function (bytes: number) {
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	if (bytes === 0) {
		return 'n/a';
	}
	const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)) + '', 10);
	if (i === 0) {
		return bytes + ' ' + sizes[i];
	}
	return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
};

/**
 * @desc 函数防抖
 * @param func 函数
 * @param wait 延迟执行毫秒数
 * @param immediate true 表立即执行，false 表非立即执行
 */
export function debounce(func: Function, wait: number, immediate?: boolean) {
    let timeout: NodeJS.Timeout | null;
    return function (this: any, ...params: any[]) {
        const context = this;
        const args = params;
        if (timeout) clearTimeout(timeout);
        if (immediate) {
            const callNow = !timeout;
            timeout = setTimeout(() => {
                timeout = null;
            }, wait);
            if (callNow) func.apply(context, args);
        }
        else {
            timeout = setTimeout(() =>  {
                func.apply(context, args);
            }, wait);
        }
    };
}