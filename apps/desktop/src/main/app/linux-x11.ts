export const LINUX_X11_SWITCH = "--ozone-platform=x11"

interface RelaunchableApplication {
  commandLine: {
    getSwitchValue(name: string): string
  }
  exit(exitCode?: number): void
  relaunch(options: { args: string[] }): void
}

export function relaunchForLinuxX11(
  application: RelaunchableApplication,
  platform: NodeJS.Platform,
  argv: readonly string[],
  environment: Readonly<{ WAYLAND_DISPLAY?: string; XDG_SESSION_TYPE?: string }>
): boolean {
  const isWaylandSession =
    environment.XDG_SESSION_TYPE === "wayland" || Boolean(environment.WAYLAND_DISPLAY)
  if (
    platform !== "linux" ||
    !isWaylandSession ||
    application.commandLine.getSwitchValue("ozone-platform") === "x11"
  ) {
    return false
  }

  const args = argv.slice(1).filter((argument) => !argument.startsWith("--ozone-platform="))
  application.relaunch({ args: [...args, LINUX_X11_SWITCH] })
  application.exit(0)
  return true
}
