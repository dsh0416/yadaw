import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MidiJournalWriter } from "./midi-recording-commit.fixture"
import { RecordingService } from "./recording-service"

const commitMidiRecordingTakes = vi.hoisted(() =>
  vi.fn(
    async (
      _commands: unknown,
      workspace: unknown,
      _operationId?: unknown,
      _startTick?: unknown,
      _takes?: unknown,
      _trackNames?: unknown
    ) => workspace
  )
)

vi.mock("./midi-recording-commit", () => ({
  commitMidiRecordingTakes
}))

describe("RecordingService MIDI orchestration", () => {
  const directories: string[] = []
  const previousTestCapture = process.env.HERON_TEST_CAPTURE_SOURCE

  beforeEach(() => {
    delete process.env.HERON_TEST_CAPTURE_SOURCE
    commitMidiRecordingTakes.mockClear()
    commitMidiRecordingTakes.mockImplementation(async (_commands, workspace) => workspace)
  })

  afterEach(async () => {
    if (previousTestCapture === undefined) {
      delete process.env.HERON_TEST_CAPTURE_SOURCE
    } else {
      process.env.HERON_TEST_CAPTURE_SOURCE = previousTestCapture
    }
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function createHarness(options?: {
    midiClips?: Array<{ id: string }>
    armedAudio?: boolean
    missingTrack?: boolean
  }) {
    const swapDirectory = await mkdtemp(join(tmpdir(), "heron-recording-midi-svc-"))
    directories.push(swapDirectory)
    const projectPath = join(swapDirectory, "project.heron")
    const midiClips = options?.midiClips ?? []
    type HarnessChannel = {
      id: string
      kind: "instrument" | "audio"
      systemRole: "metronome" | null
      name: string
      recordArmed: boolean
      inputChannels: number[]
      midiInput: { portId: string; channel: number } | null
    }
    const channels: HarnessChannel[] = [
      {
        id: "ch:keys",
        kind: "instrument",
        systemRole: null,
        name: "Keys",
        recordArmed: true,
        inputChannels: [],
        midiInput: { portId: "port-a", channel: 3 }
      },
      {
        id: "metronome",
        kind: "instrument",
        systemRole: "metronome",
        name: "Metronome",
        recordArmed: true,
        inputChannels: [],
        midiInput: null
      }
    ]
    if (options?.armedAudio) {
      channels.unshift({
        id: "ch:audio",
        kind: "audio",
        systemRole: null,
        name: "Audio",
        recordArmed: true,
        inputChannels: [1, 2],
        midiInput: null
      })
    }
    const tracks = options?.missingTrack
      ? []
      : [
          ...(options?.armedAudio
            ? [{ id: "track:audio", channelId: "ch:audio", sortOrder: 0 }]
            : []),
          { id: "track:keys", channelId: "ch:keys", sortOrder: 1 }
        ]

    const settings = {
      get: vi.fn().mockResolvedValue({
        swapDirectory,
        recordingBitDepth: "float32" as const
      })
    }
    const projects = {
      current: {
        path: projectPath,
        configuration: { sampleRate: 48_000 }
      },
      assetContentHashes: vi.fn().mockResolvedValue([]),
      importLargeObject: vi.fn(),
      defaultRecordingTrack: vi.fn(),
      cancelOperation: vi.fn()
    }
    const operations = {
      upsert: vi.fn(),
      patch: vi.fn(),
      setCancelHandler: vi.fn()
    }
    const graphs = {
      snapshot: vi.fn().mockResolvedValue({
        tracks,
        channels,
        midiClips
      }),
      deleteUnusedAssets: vi.fn()
    }
    const transport = {
      snapshot: vi.fn().mockResolvedValue({
        state: "stopped",
        positionFrames: 0,
        positionTicks: 960
      }),
      command: vi.fn().mockResolvedValue(undefined)
    }
    let lastMidiStartTakes: Array<{
      path: string
      sourceId: string
      clipId: string
      trackId: string
    }> = []
    const audioHost = {
      audioEngineSnapshot: vi.fn().mockResolvedValue({
        state: "running",
        inputSampleRate: 48_000
      }),
      transportControlSnapshot: vi.fn().mockResolvedValue({
        state: "playing",
        positionFrames: 480,
        positionTicks: 960
      }),
      startRecording: vi.fn().mockResolvedValue(undefined),
      stopRecording: vi.fn().mockResolvedValue({
        frameCount: 4_800,
        dropoutFrames: 0,
        channels: 2
      }),
      startMidiRecording: vi
        .fn()
        .mockImplementation(async (config: { takes: typeof lastMidiStartTakes }) => {
          lastMidiStartTakes = config.takes.map((take) => ({
            path: take.path,
            sourceId: take.sourceId,
            clipId: take.clipId,
            trackId: take.trackId
          }))
        }),
      stopMidiRecording: vi.fn().mockImplementation(async () => ({
        takes: lastMidiStartTakes.map((take) => ({
          path: take.path,
          sourceId: take.sourceId,
          clipId: take.clipId,
          trackId: take.trackId,
          eventCount: 2,
          droppedEvents: 1
        }))
      }))
    }
    const workspaceGraph = {
      midiClips,
      tracks: tracks.map((track) => ({ id: track.id, channelId: track.channelId })),
      channels: channels.map((channel) => ({ id: channel.id, name: channel.name }))
    }
    const commands = {
      currentWorkspace: vi.fn().mockReturnValue({
        projectGraph: { kind: "project-graph", id: "g", epoch: "1", generation: 1 },
        revision: 1,
        graph: workspaceGraph,
        session: { path: projectPath }
      }),
      executeMidiImport: vi.fn()
    }
    const service = new RecordingService(
      settings as never,
      projects as never,
      operations as never,
      graphs as never,
      transport as never,
      audioHost as never,
      commands as never
    )
    return {
      service,
      swapDirectory,
      projectPath,
      settings,
      projects,
      operations,
      graphs,
      transport,
      audioHost,
      commands
    }
  }

  it("starts MIDI-only recording and arms instrument takes", async () => {
    const { service, audioHost, transport, swapDirectory } = await createHarness()

    const session = await service.start()

    expect(session.audioTrackIds).toEqual([])
    expect(session.midiTrackIds).toEqual(["track:keys"])
    expect(session.trackIds).toEqual(["track:keys"])
    expect(session.startTick).toBe(960)
    expect(session.swapPath.endsWith(".midi-only")).toBe(true)
    expect(audioHost.startRecording).not.toHaveBeenCalled()
    expect(audioHost.startMidiRecording).toHaveBeenCalledOnce()
    const startConfig = audioHost.startMidiRecording.mock.calls[0]![0]
    expect(startConfig.takes).toHaveLength(1)
    expect(startConfig.takes[0]).toMatchObject({
      trackId: "track:keys",
      portId: "port-a",
      channel: 3
    })
    expect(startConfig.takes[0]!.path.endsWith(".partial.midijournal")).toBe(true)
    expect(transport.command).toHaveBeenCalledWith({ type: "record" })

    const sidecar = JSON.parse(
      await readFile(join(swapDirectory, `${session.id}.recording.json`), "utf8")
    )
    expect(sidecar).toMatchObject({
      channels: 0,
      midiTrackIds: ["track:keys"],
      audioTrackIds: [],
      resumePlaybackAfterRecording: true
    })
    expect(sidecar.tracks).toEqual([])
    expect(sidecar.midiTakes).toHaveLength(1)
  })

  it("rolls back MIDI start when transport arming fails", async () => {
    const { service, audioHost, transport, swapDirectory } = await createHarness()
    transport.command.mockRejectedValueOnce(new Error("transport busy"))

    await expect(service.start()).rejects.toThrow("transport busy")
    expect(audioHost.startMidiRecording).toHaveBeenCalledOnce()
    expect(audioHost.stopMidiRecording).toHaveBeenCalledOnce()
    expect(service.current).toBeNull()

    const listing = await readdir(swapDirectory)
    expect(listing.filter((name) => name.endsWith(".recording.json"))).toEqual([])
    expect(listing.filter((name) => name.endsWith(".midijournal"))).toEqual([])
  })

  it("aborts an active MIDI session without stopping audio capture", async () => {
    const { service, audioHost, transport } = await createHarness()
    await service.start()
    expect(service.current).not.toBeNull()

    await service.abortStart()

    expect(service.current).toBeNull()
    expect(audioHost.stopRecording).not.toHaveBeenCalled()
    expect(audioHost.stopMidiRecording).toHaveBeenCalledOnce()
    expect(transport.command).toHaveBeenCalledWith({ type: "pause" })
  })

  it("stops MIDI-only recording, merges host stats, and commits takes", async () => {
    const { service, audioHost, projects, operations } = await createHarness()
    const session = await service.start()

    const pending = await service.stop()

    expect(audioHost.stopRecording).not.toHaveBeenCalled()
    expect(audioHost.stopMidiRecording).toHaveBeenCalledOnce()
    expect(pending).toMatchObject({
      id: session.id,
      state: "committed",
      assetExists: true,
      channels: 0
    })
    expect(pending.midiTakes).toEqual([
      expect.objectContaining({
        trackId: "track:keys",
        eventCount: 2,
        droppedEvents: 1
      })
    ])
    expect(commitMidiRecordingTakes).toHaveBeenCalledOnce()
    expect(commitMidiRecordingTakes.mock.calls[0]![3]).toBe(960)
    expect(projects.importLargeObject).not.toHaveBeenCalled()
    expect(operations.patch).toHaveBeenCalledWith(
      expect.stringContaining("recording:"),
      expect.objectContaining({ state: "completed" }),
      true
    )
  })

  it("treats MIDI takes as already committed when clips exist in the graph", async () => {
    const { service, projects, graphs, swapDirectory, projectPath } = await createHarness({
      midiClips: [{ id: "clip-already" }]
    })
    const id = "already-midi"
    const journalPath = join(swapDirectory, `${id}.track-keys.partial.midijournal`)
    const sidecarPath = join(swapDirectory, `${id}.recording.json`)
    await writeFile(
      sidecarPath,
      JSON.stringify({
        id,
        state: "ready",
        audioPath: join(swapDirectory, `${id}.midi-only`),
        sidecarPath,
        projectPath,
        sampleRate: 48_000,
        channels: 0,
        startedAt: Date.now(),
        dropoutFrames: 0,
        assetExists: false,
        finalPath: null,
        bitDepth: "float32",
        frameCount: 0,
        contentHash: null,
        startFrame: 0,
        startTick: 0,
        recordedTracks: [],
        tracks: [],
        midiTakes: [
          {
            trackId: "track:keys",
            sourceId: "source-1",
            clipId: "clip-already",
            journalPath,
            eventCount: 1,
            droppedEvents: 0
          }
        ],
        midiTrackIds: ["track:keys"],
        audioTrackIds: [],
        resumePlaybackAfterRecording: false
      })
    )

    const recovered = await service.recover(id)

    expect(recovered).toMatchObject({ id, state: "committed", assetExists: true })
    expect(projects.assetContentHashes).not.toHaveBeenCalled()
    expect(graphs.deleteUnusedAssets).not.toHaveBeenCalled()
    expect(commitMidiRecordingTakes).not.toHaveBeenCalled()
  })

  it("recovers a MIDI-only partial sidecar through commit", async () => {
    const { service, graphs, operations, swapDirectory, projectPath } = await createHarness()
    const id = "recover-midi"
    const journalPath = join(swapDirectory, `${id}.track-keys.partial.midijournal`)
    const sidecarPath = join(swapDirectory, `${id}.recording.json`)
    await MidiJournalWriter.write(journalPath, {
      sourceId: "source-recover",
      clipId: "clip-recover",
      trackId: "track:keys",
      records: [
        { tick: 0, bytes: [0x90, 60, 100] },
        { tick: 480, bytes: [0x80, 60, 40] }
      ]
    })
    await writeFile(
      sidecarPath,
      JSON.stringify({
        id,
        state: "partial",
        audioPath: join(swapDirectory, `${id}.midi-only`),
        sidecarPath,
        projectPath,
        sampleRate: 48_000,
        channels: 0,
        startedAt: Date.now(),
        dropoutFrames: 0,
        assetExists: false,
        finalPath: null,
        bitDepth: "float32",
        frameCount: 0,
        contentHash: null,
        startFrame: 0,
        startTick: 480,
        recordedTracks: [],
        tracks: [],
        midiTakes: [
          {
            trackId: "track:keys",
            sourceId: "source-recover",
            clipId: "clip-recover",
            journalPath,
            eventCount: 0,
            droppedEvents: 0
          }
        ],
        midiTrackIds: ["track:keys"],
        audioTrackIds: [],
        resumePlaybackAfterRecording: false
      })
    )

    const recovered = await service.recover(id)

    expect(graphs.deleteUnusedAssets).not.toHaveBeenCalled()
    expect(commitMidiRecordingTakes).toHaveBeenCalledOnce()
    expect(commitMidiRecordingTakes.mock.calls[0]![3]).toBe(480)
    expect(commitMidiRecordingTakes.mock.calls[0]![4]).toEqual([
      expect.objectContaining({ clipId: "clip-recover", journalPath })
    ])
    expect(recovered).toMatchObject({ id, state: "committed", assetExists: true })
    expect(operations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "repairing-header" }),
      true
    )
  })

  it("rejects start when an armed instrument channel has no track", async () => {
    const { service, audioHost } = await createHarness({ missingTrack: true })
    await expect(service.start()).rejects.toThrow(/has no project track/)
    expect(audioHost.startMidiRecording).not.toHaveBeenCalled()
  })
})
