import { homedir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  root: string;
  database: string;
  backups: string;
}

export function resolveAppPaths(
  environment: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const root =
    environment.JOBPILOT_DATA_DIR ??
    join(
      environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "JobPilot",
    );
  return {
    root,
    database: join(root, "jobpilot.db"),
    backups: join(root, "backups"),
  };
}
