import type { Mock } from "vitest"

export interface ElectronMocks {
  handle: Mock
  showSaveDialog: Mock
  showOpenDialog: Mock
  getAllWindows: Mock
  fromWebContents: Mock
  shellOpenPath: Mock
  quit: Mock
  showAboutPanel: Mock
  getPath: Mock
}
