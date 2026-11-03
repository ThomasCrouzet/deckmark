import { CliError, EXIT } from './exit';

export type OptionValue = string | true;

export interface ParsedArgs {
	positionals: string[];
	options: Map<string, OptionValue>;
}

export interface OptionSpec {
	/** Options that take one value. */
	values?: readonly string[];
	/** Boolean flags. */
	flags?: readonly string[];
	/** Short aliases, for example `h` for `help`. */
	aliases?: Readonly<Record<string, string>>;
}

function usage(message: string): CliError {
	return new CliError(EXIT.USAGE, 'usage', message);
}

/** Parses long options and positionals. Unknown options are usage errors. */
export function parseArgs(tokens: readonly string[], spec: OptionSpec): ParsedArgs {
	const values = new Set(spec.values ?? []);
	const flags = new Set([...(spec.flags ?? []), 'help', 'version']);
	const aliases = spec.aliases ?? {};
	const positionals: string[] = [];
	const options = new Map<string, OptionValue>();
	let endOfOptions = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (endOfOptions || token === '-' || !token.startsWith('-')) {
			positionals.push(token);
			continue;
		}
		if (token === '--') {
			endOfOptions = true;
			continue;
		}
		let name: string;
		let inlineValue: string | undefined;
		if (token.startsWith('--')) {
			const equals = token.indexOf('=');
			name = token.slice(2, equals < 0 ? undefined : equals);
			if (equals >= 0) inlineValue = token.slice(equals + 1);
		} else {
			name = token.slice(1);
			if (name.length !== 1) throw usage(`Unknown option: ${token}`);
		}
		name = aliases[name] ?? name;
		if (flags.has(name)) {
			if (inlineValue !== undefined) throw usage(`Option --${name} does not take a value`);
			options.set(name, true);
			continue;
		}
		if (!values.has(name)) throw usage(`Unknown option: --${name}`);
		const value = inlineValue ?? tokens[++index];
		if (value === undefined) throw usage(`Option --${name} needs a value`);
		options.set(name, value);
	}
	return { positionals, options };
}

export function hasOption(args: ParsedArgs, name: string): boolean {
	return args.options.has(name);
}

export function option(args: ParsedArgs, name: string): string | undefined {
	const value = args.options.get(name);
	return typeof value === 'string' ? value : undefined;
}

export function numberOption(
	args: ParsedArgs,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	const raw = option(args, name);
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) throw usage(`Option --${name} needs an integer`);
	const value = Number(raw);
	if (value < minimum || value > maximum)
		throw usage(`Option --${name} must be between ${minimum} and ${maximum}`);
	return value;
}

export function requireOption(args: ParsedArgs, name: string): string {
	const value = option(args, name);
	if (!value) throw usage(`Option --${name} is required`);
	return value;
}
