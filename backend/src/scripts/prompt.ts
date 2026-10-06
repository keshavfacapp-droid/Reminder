import readline from 'node:readline';
import { Writable } from 'node:stream';

/** Reads a line from the terminal; when `hidden` is set nothing is echoed. */
export function prompt(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function askNewPassword(): Promise<string> {
  if (process.argv.includes('--password-stdin')) return readStdin();
  const a = await prompt('Password (min 12 characters): ', true);
  const b = await prompt('Repeat password: ', true);
  if (a !== b) throw new Error('Passwords do not match.');
  return a;
}
