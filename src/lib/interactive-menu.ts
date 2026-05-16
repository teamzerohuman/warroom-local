import { select } from '@inquirer/prompts';
import type { Command } from 'commander';

const BACK = Symbol('back');

function visibleSubcommands(command: Command): Command[] {
  return command.commands.filter((cmd) => {
    const name = cmd.name();
    if (!name || name === 'help') return false;
    if ((cmd as unknown as { _hidden?: boolean })._hidden) return false;
    return true;
  });
}

export async function pickCommandPath(root: Command): Promise<string[] | null> {
  const trail: { name: string; command: Command }[] = [];
  let current = root;

  while (true) {
    const subs = visibleSubcommands(current);
    if (subs.length === 0) return trail.map((entry) => entry.name);

    const nameWidth = Math.min(20, Math.max(...subs.map((cmd) => cmd.name().length)));
    const choices: Array<{ name: string; value: Command | typeof BACK; short: string }> = subs.map((cmd) => ({
      name: `${cmd.name().padEnd(nameWidth)}  ${cmd.description() ?? ''}`.trimEnd(),
      value: cmd,
      short: cmd.name(),
    }));
    if (trail.length > 0) {
      choices.push({ name: '← back', value: BACK, short: 'back' });
    }

    const breadcrumb = ['warroom', ...trail.map((entry) => entry.name)].join(' ');
    let picked: Command | typeof BACK;
    try {
      picked = await select({
        message: `${breadcrumb} >`,
        choices,
        pageSize: Math.min(20, choices.length),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'ExitPromptError') return null;
      throw error;
    }

    if (picked === BACK) {
      trail.pop();
      current = trail.length === 0 ? root : trail[trail.length - 1]!.command;
      continue;
    }

    trail.push({ name: picked.name(), command: picked });
    current = picked;
  }
}
