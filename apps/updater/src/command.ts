// an error message goes to chat, and a remote URL can carry a token
const URL_CREDENTIALS = /\/\/[^/@\s]+@/g;

export type TCommandResult = { exitCode: number; output: string };

export function hideCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, "//");
}

// NOTE: Compose interpolates ${PWD} from the client's environment, which a container does not set,
// so every command gets it explicitly. output: stderr, or stdout when stderr is empty
export async function exec(command: string[], cwd: string): Promise<TCommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, PWD: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 0) {
    return { exitCode, output: stdout.trimEnd() };
  }

  return { exitCode, output: hideCredentials(stderr.trim() || stdout.trim()) };
}

// returns stdout; throws on a non-zero exit with the end of the output
export async function run(command: string[], cwd: string): Promise<string> {
  const result = await exec(command, cwd);

  if (result.exitCode !== 0) {
    // credentials are removed before the cut, so a token cannot survive in part
    throw new Error(`${hideCredentials(command.join(" "))} failed: ${result.output.slice(-500)}`);
  }

  return result.output;
}
