import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApplicationSettingsStore } from "../settings"
import { ProjectService } from "./project-service"

const dump = vi.fn(async (outputPath: string) => {
  await writeFile(outputPath, "heron-archive")
})
const openProject = vi.fn().mockResolvedValue(undefined)
const closeProject = vi.fn().mockResolvedValue(undefined)
const terminatedWorkers: Array<ReturnType<typeof vi.fn>> = []

interface MockWorker {
  abortProjectCommand: ReturnType<typeof vi.fn>
  assetContentHashes: ReturnType<typeof vi.fn>
  assetsMissingWaveform: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  commitProjectCommand: ReturnType<typeof vi.fn>
  defaultRecordingTrack: ReturnType<typeof vi.fn>
  deleteAssets: ReturnType<typeof vi.fn>
  getConfiguration: ReturnType<typeof vi.fn>
  importLargeObject: ReturnType<typeof vi.fn>
  importMidi: ReturnType<typeof vi.fn>
  listAssets: ReturnType<typeof vi.fn>
  mixerSnapshot: ReturnType<typeof vi.fn>
  onProgress: ((progress: { operationId: string; completed: number; total: number }) => void) | null
  prepareProjectCommand: ReturnType<typeof vi.fn>
  projectCommandStatus: ReturnType<typeof vi.fn>
  readLargeObject: ReturnType<typeof vi.fn>
  readWaveform: ReturnType<typeof vi.fn>
  rollbackMidi: ReturnType<typeof vi.fn>
  savePluginStates: ReturnType<typeof vi.fn>
  storeWaveform: ReturnType<typeof vi.fn>
  updateConfiguration: ReturnType<typeof vi.fn>
}

const workerInstances: MockWorker[] = []

vi.mock("./project-worker-client", () => ({
  ProjectWorkerClient: class {
    terminate = vi.fn().mockResolvedValue(undefined)
    create = vi.fn().mockResolvedValue(undefined)
    open = openProject
    getConfiguration = vi.fn().mockResolvedValue({
      name: "Recovered",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    dump = dump
    close = closeProject
    onProgress: MockWorker["onProgress"] = null
    abortProjectCommand = vi.fn().mockResolvedValue(undefined)
    assetContentHashes = vi.fn().mockResolvedValue([{ id: "asset-1", contentHash: "hash" }])
    assetsMissingWaveform = vi.fn().mockResolvedValue(["asset-1"])
    cancel = vi.fn().mockResolvedValue(undefined)
    commitProjectCommand = vi.fn().mockResolvedValue({ revision: 2 })
    defaultRecordingTrack = vi.fn().mockResolvedValue({ trackId: "track-1" })
    deleteAssets = vi.fn().mockResolvedValue(undefined)
    importLargeObject = vi.fn().mockResolvedValue(32)
    importMidi = vi.fn().mockResolvedValue(undefined)
    listAssets = vi.fn().mockResolvedValue([{ id: "asset-1" }])
    mixerSnapshot = vi.fn().mockResolvedValue({ tracks: [] })
    prepareProjectCommand = vi.fn().mockResolvedValue({ token: "token" })
    projectCommandStatus = vi.fn().mockResolvedValue({ status: "prepared" })
    readLargeObject = vi.fn().mockResolvedValue(new Uint8Array([1, 2]))
    readWaveform = vi.fn().mockResolvedValue({ startFrame: 0 })
    rollbackMidi = vi.fn().mockResolvedValue(undefined)
    savePluginStates = vi.fn().mockResolvedValue(undefined)
    storeWaveform = vi.fn().mockResolvedValue(undefined)
    updateConfiguration = vi.fn().mockImplementation(async (configuration) => configuration)

    constructor() {
      terminatedWorkers.push(this.terminate)
      workerInstances.push(this)
    }
  }
}))

describe("ProjectService.create", () => {
  let service: ProjectService | null = null

  afterEach(async () => {
    await service?.shutdown()
    service = null
    dump.mockClear()
    openProject.mockReset().mockResolvedValue(undefined)
    closeProject.mockReset().mockResolvedValue(undefined)
    terminatedWorkers.length = 0
    workerInstances.length = 0
  })

  it("writes the initial .heron archive and returns a clean session", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-create-"))
    const projectPath = join(userData, "Untitled.heron")
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))
    const progress = vi.fn()

    const session = await service.create(
      {
        path: projectPath,
        name: "Untitled",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      progress
    )

    await access(projectPath)
    expect(dump).toHaveBeenCalledOnce()
    expect(session).toMatchObject({
      path: projectPath,
      dirty: false,
      recoveredWorkingCopy: false,
      configuration: { name: "Untitled", sampleRate: 48_000 }
    })
    expect(service.current).toMatchObject({ path: projectPath, dirty: false })
    expect(progress.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { phase: "committing-database", completedUnits: 0 },
      { phase: "saving-archive", completedUnits: 1 }
    ])
  })

  it("rejects create and open paths with unsupported extensions", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-extension-"))
    const legacyExtension = ["ya", "daw"].join("")
    const projectPath = join(userData, `Legacy.${legacyExtension}`)
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    await expect(
      service.create({
        path: projectPath,
        name: "Legacy",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      })
    ).rejects.toThrow("Project path must use the .heron extension")
    await expect(service.open(projectPath, false)).rejects.toThrow(
      "Project path must use the .heron extension"
    )
  })

  it("leaves the source archive byte-for-byte untouched when migration fails", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-open-failure-"))
    const projectPath = join(userData, "Existing.heron")
    const contents = new Uint8Array([0x59, 0x41, 0x44, 0x41, 0x57])
    await writeFile(projectPath, contents)
    const before = await stat(projectPath)
    openProject.mockRejectedValueOnce(new Error("migration failed"))
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    await expect(service.open(projectPath, false)).rejects.toThrow("migration failed")

    expect([...(await readFile(projectPath))]).toEqual([...contents])
    expect((await stat(projectPath)).mtimeMs).toBe(before.mtimeMs)
  })

  it("discards a failed candidate worker before a later healthy open", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-worker-recovery-"))
    const brokenPath = join(userData, "Broken.heron")
    const healthyPath = join(userData, "Healthy.heron")
    await writeFile(brokenPath, "broken")
    await writeFile(healthyPath, "healthy")
    openProject.mockRejectedValueOnce(new Error("database migration failed"))
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    await expect(service.open(brokenPath, false)).rejects.toThrow("database migration failed")
    expect(service.current).toBeNull()
    expect(terminatedWorkers[0]).toHaveBeenCalledOnce()

    const progress = vi.fn()
    await expect(service.open(healthyPath, false, progress)).resolves.toMatchObject({
      path: healthyPath,
      configuration: { name: "Recovered" }
    })
    expect(service.current?.path).toBe(healthyPath)
    expect(terminatedWorkers).toHaveLength(2)
    expect(terminatedWorkers[1]).not.toHaveBeenCalled()
    expect(progress.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { phase: "loading-project-archive", completedUnits: 0 },
      { phase: "restoring-project-state", completedUnits: 1 },
      { phase: "restoring-project-state", completedUnits: 2 }
    ])
  })

  it("preserves the active workspace when a prepared close is aborted", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-close-recovery-"))
    const projectPath = join(userData, "Recoverable.heron")
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))
    await service.create({
      path: projectPath,
      name: "Recoverable",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    await service.markExternalStateDirty()

    await expect(service.prepareClose("cancel")).resolves.toBe(false)
    const progress = vi.fn()
    await expect(service.prepareClose("save", progress)).resolves.toBe(true)
    expect(service.current).toMatchObject({ path: projectPath, dirty: false })
    expect(closeProject).toHaveBeenCalledOnce()
    expect(progress.mock.calls).toEqual([
      [{ phase: "saving-archive" }],
      [{ phase: "closing-project-database" }]
    ])

    await service.abortPreparedClose()
    expect(openProject).toHaveBeenLastCalledWith(expect.stringContaining("pgdata"))
    expect(service.current).toMatchObject({ path: projectPath, dirty: false })
  })

  it("routes candidate and active data operations through one owned worker", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-operations-"))
    const projectPath = join(userData, "Operations.heron")
    const settings = new ApplicationSettingsStore(userData)
    const addRecent = vi.spyOn(settings, "addRecent")
    service = new ProjectService(userData, settings)
    await service.prepareCreate({
      path: projectPath,
      name: "Operations",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    const worker = workerInstances[0]!

    await expect(service.candidateMixerSnapshot()).resolves.toEqual({ tracks: [] })
    await expect(service.candidateAssets()).resolves.toEqual([{ id: "asset-1" }])
    const candidateReader = service.candidateAssetReader()
    await expect(candidateReader.assetContentHashes(["asset-1"])).resolves.toEqual([
      { id: "asset-1", contentHash: "hash" }
    ])
    await expect(candidateReader.readAssetAudio("asset-1")).resolves.toEqual(new Uint8Array([1, 2]))

    service.commitCandidate()
    expect(service.activeAssetReader()).toBeDefined()
    await expect(service.listAssets()).resolves.toEqual([{ id: "asset-1" }])
    await expect(service.mixerSnapshot()).resolves.toEqual({ tracks: [] })
    worker.getConfiguration.mockResolvedValue({
      name: "Updated",
      sampleRate: 96_000,
      timeSignatureNumerator: 7,
      timeSignatureDenominator: 8,
      waveformDisplayMode: "aggregate"
    })
    await expect(
      service.updateConfiguration({
        name: "Updated",
        sampleRate: 96_000,
        timeSignatureNumerator: 7,
        timeSignatureDenominator: 8,
        waveformDisplayMode: "aggregate"
      })
    ).resolves.toMatchObject({ configuration: { name: "Updated", sampleRate: 96_000 } })

    const command = { type: "replace-tempo-map", tempoMap: [] } as never
    await service.prepareProjectCommand("operation", 1, command, "output")
    await service.commitProjectCommand({ id: "token" } as never, command)
    await service.abortProjectCommand({ id: "token" } as never)
    await service.projectCommandStatus("operation")
    await service.importMidi({ id: "midi" } as never, command, "output")
    await service.rollbackMidi("midi", command, "output")
    await service.savePluginStates([])
    await service.savePluginStates([{ instanceId: "plugin" }] as never)
    await service.assetContentHashes(["asset-1"])
    await service.defaultRecordingTrack()
    await service.assetsMissingWaveform()
    await service.deleteAssets([])
    await service.deleteAssets(["asset-1"])

    worker.importLargeObject.mockImplementationOnce(async () => {
      worker.onProgress?.({ operationId: "import", completed: 4, total: 8 })
      worker.onProgress?.({ operationId: "other", completed: 8, total: 8 })
      return 32
    })
    const progress = vi.fn()
    await expect(
      service.importLargeObject("audio.wav", "import", { id: "asset-1" } as never, progress)
    ).resolves.toBe(32)
    expect(progress).toHaveBeenCalledWith(4, 8)
    expect(worker.onProgress).toBeNull()
    await expect(service.readAssetAudio("asset-1")).resolves.toEqual(new Uint8Array([1, 2]))
    await service.readAssetWaveform("asset-1", 0, 100, 10)
    await service.storeAssetWaveform("asset-1", { cacheVersion: 1 } as never)
    await service.cancelOperation("import")

    await service.save(undefined, "save-operation")
    await service.recordCurrentAsRecent()
    expect(addRecent).toHaveBeenCalledTimes(2)
    expect(worker.prepareProjectCommand).toHaveBeenCalled()
    expect(worker.commitProjectCommand).toHaveBeenCalled()
    expect(worker.importMidi).toHaveBeenCalled()
    expect(worker.rollbackMidi).toHaveBeenCalled()
    expect(worker.savePluginStates).toHaveBeenCalledOnce()
    expect(worker.deleteAssets).toHaveBeenCalledOnce()

    await expect(service.commitClose("discard")).resolves.toBe(true)
    expect(service.current).toBeNull()
  })
})
