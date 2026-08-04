# Heron brand assets

`heron-logo.png` is the canonical, unmodified source artwork. Generated app,
website, and UI assets keep the artwork intact and only apply resizing, safe
area, and rounded-corner masks appropriate to their destination.

| Destination           | Asset                                   | Treatment                              |
| --------------------- | --------------------------------------- | -------------------------------------- |
| macOS bundle          | `apps/desktop/build/icon.icns`          | 9.8% safe area, 22.5% corner radius    |
| Windows bundle        | `apps/desktop/build/icon.ico`           | 3.1% safe area, 18.3% corner radius    |
| Linux bundle          | `apps/desktop/build/icons/*.png`        | Full-size artwork, 17.6% corner radius |
| macOS runtime         | `apps/desktop/build/icon-macos.png`     | Matches the macOS bundle safe area     |
| Windows/Linux runtime | `apps/desktop/build/icon.png`           | Matches the Linux desktop icon         |
| Shared Vue UI         | `packages/ui/src/assets/heron-logo.png` | Full-size artwork, 20% corner radius   |
| Documentation site    | `docs/content/public/logo.png`          | Matches the shared UI mark             |

The original artwork is RGB. Derived PNG assets use alpha only outside their
rounded masks; no colors or internal logo geometry are changed.
