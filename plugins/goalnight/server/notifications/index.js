/**
 * Notification module entry point.
 *
 * v0.1: macOS only — re-exports macos.js.
 * v0.2: will branch on process.platform to dispatch to macos / linux / windows.
 */

export { notify } from './macos.js';
