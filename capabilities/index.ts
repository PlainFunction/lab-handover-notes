// The parts of Plain Function's capabilities this lab uses. Everything under
// ./core is a copy of capabilities/core in the monorepo, kept in step
// with it automatically, from what this file reaches. Don't edit the
// copies; change capabilities/ and sync. Add a line here to use another part.

// Kernel: ports, the registry the lab is wired in, logs.
export { Port, type Manifest } from './core/kernel/port'
export { Module, Registry } from './core/kernel/registry'
export { Logger } from './core/kernel/logger'

// Telemetry: every port traced, logs to Loki tied to their trace.
export { Telemetry, MemoryTelemetry, activeTelemetry } from './core/telemetry/telemetry'
export { bindTelemetry, traceFetch, type TelemetryEnv } from './core/telemetry/registry'
