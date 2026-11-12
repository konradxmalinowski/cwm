import { CliError } from './context';

type Validator = (value: string) => string | undefined;

async function clack(): Promise<typeof import('@clack/prompts')> {
  return import('@clack/prompts');
}

function cancelled(): CliError {
  return new CliError('Przerwano.', 1);
}

export async function promptText(
  message: string,
  options: { readonly placeholder?: string; readonly validate?: Validator } = {},
): Promise<string> {
  const p = await clack();
  const value = await p.text({
    message,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    validate: (input) => (options.validate ? options.validate(input ?? '') : undefined),
  });
  if (p.isCancel(value)) {
    p.cancel('Przerwano.');
    throw cancelled();
  }
  return value;
}

export async function promptSelect<T extends string>(
  message: string,
  choices: readonly T[],
): Promise<T> {
  const p = await clack();
  const value = await p.select<T>({
    message,
    options: choices.map((choice) => ({ value: choice, label: choice })) as never,
  });
  if (p.isCancel(value)) {
    p.cancel('Przerwano.');
    throw cancelled();
  }
  return value;
}

export async function promptConfirm(message: string): Promise<boolean> {
  const p = await clack();
  const value = await p.confirm({ message, initialValue: false });
  if (p.isCancel(value)) {
    p.cancel('Przerwano.');
    throw cancelled();
  }
  return value;
}

export interface MultiChoice {
  readonly value: string;
  readonly label: string;
}

/** Wielokrotny wybor; domyslnie nic nie jest zaznaczone. Anulowanie przerywa polecenie. */
export async function promptMultiSelect(
  message: string,
  choices: readonly MultiChoice[],
): Promise<string[]> {
  const p = await clack();
  const value = await p.multiselect<string>({
    message,
    options: choices.map((choice) => ({ value: choice.value, label: choice.label })),
    required: false,
    maxItems: 15,
  });
  if (p.isCancel(value)) {
    p.cancel('Przerwano.');
    throw cancelled();
  }
  return value;
}
