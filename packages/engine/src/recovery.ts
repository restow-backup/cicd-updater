import type { BackupRef } from "@cicd-updater/protocol";

/**
 * The restore commands shown for a `needs_attention` run (design 5.14). They
 * are for display: database restores are never automatic, and the operator
 * reviews them before running them on the host.
 */

export interface RecoveryContext {
  projectName: string;
  /** Profiles every Compose call needs (`compose.profiles`). */
  profiles: readonly string[];
  /** The sidecar's own Compose service. */
  selfService: string;
  /** Services to stop before a restore (the managed services with stopOnAttention). */
  stopServices: readonly string[];
  runId: string;
  backup: BackupRef | null;
  /** The database service of a postgres/mysql backup. */
  databaseService: string | null;
  /** Compose volume names of a volume backup. */
  volumes: readonly string[];
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

export function renderRecoveryCommands(context: RecoveryContext): string[] {
  const compose = [
    "docker",
    "compose",
    "-p",
    context.projectName,
    ...context.profiles.flatMap((p) => ["--profile", p]),
  ]
    .map(shellWord)
    .join(" ");
  const sidecar = `${compose} exec -T ${shellWord(context.selfService)} cicd-updater`;
  const commands: string[] = [];
  if (context.stopServices.length > 0) {
    commands.push(`${compose} stop ${context.stopServices.map(shellWord).join(" ")}`);
  }
  const backup = context.backup;
  if (backup) {
    const source = `${sidecar} backups cat ${shellWord(backup.file)}${backup.encrypted ? " | age -d -i <path-to-your-age-identity>" : ""}`;
    const db = context.databaseService ? shellWord(context.databaseService) : "<database-service>";
    switch (backup.type) {
      case "postgres":
        commands.push(
          `${source} | ${compose} exec -T ${db} sh -c 'pg_restore -U "$POSTGRES_USER" -d "$\{POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'`,
        );
        break;
      case "mysql":
        commands.push(
          `${source} | gunzip | ${compose} exec -T ${db} sh -c 'MYSQL_PWD="$\{MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" exec "$(command -v mariadb || command -v mysql)" -u root "$\{MYSQL_DATABASE:-$MARIADB_DATABASE}"'`,
        );
        break;
      case "volume":
        commands.push(
          `# restore each volume archive member into its volume (${context.volumes.join(", ")}); review before running:`,
          `${source} > ${shellWord(backup.file.replace(/\.age$/, ""))}`,
        );
        break;
      default:
        commands.push(
          `# restore with the tool that created this backup:`,
          `${source} > ${shellWord(backup.file.replace(/\.age$/, ""))}`,
        );
    }
  }
  commands.push(`${sidecar} recover restore-env ${shellWord(context.runId)}`);
  commands.push(`${compose} up -d`);
  return commands;
}
