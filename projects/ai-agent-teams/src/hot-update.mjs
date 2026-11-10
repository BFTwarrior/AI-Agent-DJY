// Hot-update packager and installer for the stable MCP shell.
//
// `buildPackage` turns a git commit into a versioned runtime directory under
// `runtime/versions/<version>-<shortsha>/` with a manifest that binds every
// packaged file by sha256. `installPackage` verifies such a package, proves it
// can complete the MCP `initialize` + `tools/list` handshake, and only then
// atomically rewrites `runtime/current.json` — the pointer the shell already
// watches. The shell keeps serving its old runtime (and drains in-flight
// requests) until the pointer changes, so a rejected or unhealthy package can
// never take the host session down.
//
// This file is the public entry point and stays deliberately thin: the
// implementation lives in `src/hot-update/`, split by concern. `scripts/hot-update.mjs`,
// the tests and any operator tooling import from here, so this facade is the
// compatibility surface — it must keep exporting the same names with the same
// meaning, and it must not grow its own logic.
//
// Modules:
//   support.mjs      on-disk contract, HotUpdateError, filesystem primitives
//   package-files.mjs allow-list collection, manifest write, import closure
//   manifest.mjs     package identity, verifyPackage, publish-target containment
//   build.mjs        git state and buildPackage
//   lock.mjs         cross-process runtime lock
//   publish.mjs      publish/commit/undo, crash journals, recovery
//   install-copy.mjs manifest-only copy of an external draft into versions/
//   pointer.mjs      runtime/current.json read, atomic write, target validation
//   health.mjs       initialize + tools/list probe and its environment rules
//   versions.mjs     installed-version listing and matching
//   operations.mjs   installPackage, getStatus, rollbackPackage
export {
  HOT_UPDATE_API_VERSION,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  DEFAULT_RUNTIME_ENTRY,
  POINTER_RELATIVE_PATH,
  VERSIONS_RELATIVE_PATH,
  HotUpdateError,
} from './hot-update/support.mjs';
export { assertPublishTargetInside, verifyPackage } from './hot-update/manifest.mjs';
export { buildPackage } from './hot-update/build.mjs';
export { acquireRuntimeLock } from './hot-update/lock.mjs';
export { recoverRuntimeState } from './hot-update/publish.mjs';
export { runHealthCheck } from './hot-update/health.mjs';
export { getStatus, installPackage, rollbackPackage } from './hot-update/operations.mjs';
