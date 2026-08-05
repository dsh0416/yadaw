# Application audio capture

Application inputs are graph-local sources. They do not install a virtual
microphone and do not expose a platform callback to the renderer.

The persisted identity is the normalized executable path/name plus the
`includeProcessTree` policy. PIDs, audio-session IDs, endpoint IDs, and route
handles are runtime-only. Windows enumerates active WASAPI render sessions on
an MTA control thread and uses Process Loopback activation for prepared routes.
ASIO and WDM exclusive streams may bypass the Windows Audio Engine and are
therefore intentionally reported as unsupported rather than silently falling
back to system loopback.

Prepared routes use a bounded SPSC float32 frame ring. A missing process or a
device invalidation leaves the graph alive and produces silence while the
control plane reports `target-missing`, `target-exited`, `no-stream`, or
`unsupported`.
