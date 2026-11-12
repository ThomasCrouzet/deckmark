#!/usr/bin/env node
// Evaluate the subset of GitHub workflow expressions that the CI gate `if:`
// lines use. A contract test can then execute a condition under several event
// and input contexts instead of matching its text.
//
// Supported syntax: dotted context paths, single or double quoted strings, the
// true, false, and null literals, `==`, `!=`, `&&`, `||`, `!`, and parentheses.
// Equality follows the documented loose rule: unlike types are compared as
// numbers, null counts as 0, and an empty string counts as 0. Any other syntax
// raises an error, so a gate that grows beyond this subset fails the test
// instead of passing silently.

const OPERATOR = /^(?:&&|\|\||==|!=|!|\(|\))/;
const STRING = /^(?:'([^']*)'|"([^"]*)")/;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/;
const LITERALS = new Map([
	['true', true],
	['false', false],
	['null', null]
]);

function tokenize(expression) {
	const tokens = [];
	let index = 0;
	while (index < expression.length) {
		const rest = expression.slice(index);
		const space = rest.match(/^\s+/);
		if (space) {
			index += space[0].length;
			continue;
		}
		const operator = rest.match(OPERATOR);
		if (operator) {
			tokens.push({ type: 'operator', value: operator[0] });
			index += operator[0].length;
			continue;
		}
		const string = rest.match(STRING);
		if (string) {
			tokens.push({ type: 'value', value: string[1] ?? string[2] });
			index += string[0].length;
			continue;
		}
		const name = rest.match(NAME);
		if (name) {
			tokens.push({ type: 'name', value: name[0] });
			index += name[0].length;
			continue;
		}
		throw new Error(`Unsupported token in the condition: ${rest.slice(0, 20)}`);
	}
	return tokens;
}

function toNumber(value) {
	if (value === null || value === undefined) return 0;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const number = Number(value);
		return Number.isNaN(number) ? NaN : number;
	}
	return NaN;
}

function equals(left, right) {
	const leftValue = left === undefined ? null : left;
	const rightValue = right === undefined ? null : right;
	if (leftValue === null || rightValue === null) {
		return toNumber(leftValue) === toNumber(rightValue);
	}
	if (typeof leftValue === 'object' || typeof rightValue === 'object') return false;
	if (typeof leftValue === typeof rightValue) return leftValue === rightValue;
	return toNumber(leftValue) === toNumber(rightValue);
}

function isTruthy(value) {
	if (value === null || value === undefined || value === false || value === '') return false;
	if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
	return true;
}

function resolve(path, contexts) {
	if (LITERALS.has(path)) return LITERALS.get(path);
	let value = contexts;
	for (const key of path.split('.')) {
		if (value === null || typeof value !== 'object') return undefined;
		value = value[key];
	}
	return value;
}

// A recursive descent parser over the token list. Precedence, from lowest to
// highest: ||, &&, equality, unary !, primary.
function parse(tokens, contexts) {
	let index = 0;

	const peek = () => tokens[index];
	const take = () => tokens[index++];
	const accept = (operator) => {
		const token = peek();
		if (token && token.type === 'operator' && token.value === operator) {
			index += 1;
			return true;
		}
		return false;
	};

	const primary = () => {
		const token = take();
		if (!token) throw new Error('The condition ends with an operator.');
		if (token.type === 'value') return token.value;
		if (token.type === 'name') return resolve(token.value, contexts);
		if (token.type === 'operator' && token.value === '(') {
			const value = or();
			if (!accept(')')) throw new Error('The condition has an unclosed group.');
			return value;
		}
		throw new Error(`Unexpected operator: ${token.value}`);
	};

	const unary = () => {
		if (accept('!')) return !isTruthy(unary());
		return primary();
	};

	const equality = () => {
		let left = unary();
		for (;;) {
			if (accept('==')) {
				left = equals(left, unary());
			} else if (accept('!=')) {
				left = !equals(left, unary());
			} else {
				return left;
			}
		}
	};

	const and = () => {
		// `&&` keeps the JavaScript value rule that GitHub documents, so the
		// `condition && 'a' || 'b'` idiom keeps its meaning. The caller reads
		// the final value as a boolean.
		let left = equality();
		while (accept('&&')) {
			const right = equality();
			left = isTruthy(left) ? right : left;
		}
		return left;
	};

	const or = () => {
		let left = and();
		while (accept('||')) {
			const right = and();
			left = isTruthy(left) ? left : right;
		}
		return left;
	};

	const value = or();
	if (index !== tokens.length) throw new Error('The condition has trailing tokens.');
	return value;
}

export function evaluateWorkflowCondition(expression, contexts = {}) {
	const text = String(expression ?? '')
		.replace(/^\s*\$\{\{/, '')
		.replace(/\}\}\s*$/, '')
		.trim();
	if (text.length === 0) throw new Error('The condition is empty.');
	return isTruthy(parse(tokenize(text), contexts));
}
