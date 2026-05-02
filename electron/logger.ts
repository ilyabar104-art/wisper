import { createWriteStream, WriteStream } from 'fs';
import { join } from 'path';
import { app } from 'electron';

let stream: WriteStream | null = null;
let logFilePath = '';

export function initLogger(): string {
  logFilePath = join(app.getPath('userData'), 'wisper.log');
  stream = createWriteStream(logFilePath, { flags: 'a' });
  const line = `\n--- session ${new Date().toISOString()} ---\n`;
  stream.write(line);
  return logFilePath;
}

export function getLogPath(): string {
  return logFilePath;
}

export function log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const msg = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`;
  stream?.write(msg);
  if (level === 'error') process.stderr.write(msg);
  else process.stdout.write(msg);
}
