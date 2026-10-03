// Recognize the observed Antigravity CLI 1.2.16 help layout only.
// Help observation does not establish read-only enforcement or model support.
const required = ['--print', '--model', '--effort', '--mode', '--sandbox',
  '--output-format', '--print-timeout', '--disable-slash-commands'];

export function parseAgyHelp(text) {
  const lines = text.split(/\r?\n/u);
  const usage = lines.findIndex((line) => /^Usage of agy\.exe:[ \t]*$/u.test(line));
  const subcommands = lines.findIndex((line, index) => index > usage &&
    /^Available subcommands:[ \t]*$/u.test(line));
  const flags = [...new Set(lines.slice(usage + 1, subcommands < 0 ? undefined : subcommands)
    .map((line) => /^[ \t]{2,}(--[a-z][a-z0-9-]*)[ \t]{2,}\S/u.exec(line)?.[1])
    .filter(Boolean))].sort();
  const commands = ['models', 'agents'].filter((name) => subcommands >= 0 &&
    lines.slice(subcommands + 1).some((line) =>
      new RegExp('^[ \\t]{2,}' + name + '[ \\t]{2,}\\S', 'u').test(line)));
  return { flags, commands, formatConfirmed: usage >= 0 && subcommands > usage &&
    required.every((flag) => flags.includes(flag)) && commands.length === 2 };
}
