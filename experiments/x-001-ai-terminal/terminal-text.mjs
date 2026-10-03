import headless from '@xterm/headless';

// ConPTY can encode line advances as cursor movements. Removing escape bytes
// concatenates unrelated lines; use the same terminal buffer semantics as a UI.
export class TerminalText {
  constructor(cols = 512, rows = 40) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 4096, allowProposedApi: true });
    this.pending = 0;
  }
  write(text) {
    this.pending++;
    this.terminal.write(text, () => { this.pending--; });
  }
  resize(cols, rows) { this.terminal.resize(cols, rows); }
  read() {
    const buffer = this.terminal.buffer.active;
    const lines = [];
    let lastContentRow = -1;
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      const value = line.translateToString(true);
      if (value.length) lastContentRow = index;
      if (line.isWrapped && lines.length) lines[lines.length - 1] += value;
      else lines.push(value);
    }
    const text = lines.join('\n').trimEnd();
    return text + (buffer.cursorX === 0 && buffer.baseY + buffer.cursorY > lastContentRow &&
      lastContentRow >= 0 ? '\n' : '');
  }
  dispose() { this.terminal.dispose(); }
}
