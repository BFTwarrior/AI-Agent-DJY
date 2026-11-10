/**
 * Log formatting for the daemon supervisor.
 *
 * Kept in its own module so the supervisor can import it while staying a plain
 * top-level script: an entry-point guard in `daemon-supervisor.mjs` would be a
 * silent failure mode, because the logon task launches that file through
 * `wscript.exe`, where a path that does not compare equal to
 * `import.meta.url` would make the supervisor exit immediately and stop
 * restarting the daemon with no visible error.
 */

/**
 * The line to log for an `ensureDaemon` result, or undefined when there is
 * nothing worth logging (a healthy daemon was adopted, or the result is
 * malformed).
 *
 * A version upgrade must be visible in the log: it restarts the daemon, and a
 * line that only says "started" would make an upgrade look like a crash loop.
 *
 * `discovery` is treated as required in practice but guarded anyway. The
 * supervisor runs unattended, so a TypeError here would be swallowed by the
 * loop's `catch` and surface only as one `ensureDaemon failed` line per
 * interval, long after the actual cause.
 * @param {{ started?: boolean, discovery?: { version?: string, port?: number|string }, replacedVersion?: string }} result
 * @returns {string | undefined}
 */
export function formatDaemonResult(result) {
  if (!result?.started || !result.discovery) return undefined;
  return result.replacedVersion
    ? `daemon replaced ${result.replacedVersion} -> ${result.discovery.version} port=${result.discovery.port}`
    : `daemon started port=${result.discovery.port}`;
}
