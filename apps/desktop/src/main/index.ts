import { app } from "electron"
import { relaunchForLinuxX11, startMainProcess } from "./app"

if (!relaunchForLinuxX11(app, process.platform, process.argv, process.env)) {
  startMainProcess(app, process.platform, process.env)
}
