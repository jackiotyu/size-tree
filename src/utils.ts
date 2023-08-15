import * as vscode from 'vscode';

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