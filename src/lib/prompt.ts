import { createInterface } from 'node:readline';
import { select } from '@inquirer/prompts';

type Output = (text: string) => void;
type Input = NodeJS.ReadableStream & { isTTY?: boolean };

export type SelectChoice<T> = {
  label: string;
  value: T;
  aliases?: string[];
};

export type SelectChoiceOptions<T> = {
  output: Output;
  input: Input;
  question: string;
  choices: SelectChoice<T>[];
  default: T;
  retryHelp: string;
};

function isInteractiveTTY(input: Input): boolean {
  return Boolean(input.isTTY) && Boolean(process.stdout.isTTY);
}

export async function selectChoice<T>(opts: SelectChoiceOptions<T>): Promise<T> {
  if (isInteractiveTTY(opts.input)) {
    const message = opts.question.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
    try {
      return await select<T>({
        message,
        default: opts.default,
        choices: opts.choices.map((choice) => ({ name: choice.label, value: choice.value })),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'ExitPromptError') return opts.default;
      throw error;
    }
  }

  opts.output(opts.question);
  const readline = createInterface({ input: opts.input, crlfDelay: Infinity });
  try {
    for await (const line of readline) {
      const answer = line.trim().toLowerCase();
      if (!answer) return opts.default;
      const match = opts.choices.find((choice) => {
        const aliases = [choice.label.toLowerCase(), ...(choice.aliases ?? []).map((a) => a.toLowerCase())];
        return aliases.includes(answer);
      });
      if (match) return match.value;
      opts.output(opts.retryHelp);
    }
  } finally {
    readline.close();
  }

  return opts.default;
}
