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
