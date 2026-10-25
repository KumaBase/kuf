import { baseName } from "./types";
export interface ExternalCommand { name: string; program: string; args: string[]; }
export interface ExternalCommandContext { directory: string; other_directory: string; file: string | null; selected: string[]; }
export function expandExternalArguments(command: ExternalCommand, context: ExternalCommandContext): string[] {
  const values: Record<string, string> = { dir: context.directory, other: context.other_directory, file: context.file ?? "", name: context.file ? baseName(context.file) : "" };
  return command.args.flatMap((arg) => arg === "{selected}" ? context.selected : [arg.replace(/\{(dir|other|file|name)\}/g, (_, key: string) => values[key])]);
}
