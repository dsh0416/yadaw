import { describe, expect, it, vi } from "vitest"
import { LINUX_X11_SWITCH, relaunchForLinuxX11 } from "./linux-x11"

function application(ozonePlatform = "") {
  return {
    commandLine: { getSwitchValue: vi.fn(() => ozonePlatform) },
    exit: vi.fn(),
    relaunch: vi.fn()
  }
}

describe("Linux X11 startup", () => {
  it("relaunches Linux with X11 before Electron initializes its platform", () => {
    const app = application("wayland")

    expect(
      relaunchForLinuxX11(app, "linux", ["/opt/Heron/heron", "--ozone-platform=wayland"], {
        XDG_SESSION_TYPE: "wayland"
      })
    ).toBe(true)
    expect(app.relaunch).toHaveBeenCalledWith({ args: [LINUX_X11_SWITCH] })
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it("does not relaunch when Linux already uses X11", () => {
    const app = application("x11")

    expect(
      relaunchForLinuxX11(app, "linux", ["/opt/Heron/heron", LINUX_X11_SWITCH], {
        WAYLAND_DISPLAY: "wayland-0"
      })
    ).toBe(false)
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it("does not change other platforms", () => {
    const app = application()

    expect(
      relaunchForLinuxX11(app, "win32", ["C:\\Heron\\heron.exe"], {
        XDG_SESSION_TYPE: "wayland"
      })
    ).toBe(false)
    expect(app.relaunch).not.toHaveBeenCalled()
  })

  it("does not relaunch an existing X11 session", () => {
    const app = application()

    expect(
      relaunchForLinuxX11(app, "linux", ["/opt/Heron/heron"], {
        XDG_SESSION_TYPE: "x11"
      })
    ).toBe(false)
    expect(app.relaunch).not.toHaveBeenCalled()
  })
})
