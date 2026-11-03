import { main } from './main';
import { EXIT } from './exit';

process.once('SIGINT', () => {
	process.stderr.write('deckmark: cancelled\n');
	process.exit(EXIT.ABORTED);
});

void main(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
