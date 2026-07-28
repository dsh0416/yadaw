import type { Results } from "@electric-sql/pglite"
import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import type { StoredWaveformWindow } from "./protocol"

export interface WaveformExecutor {
  execute(query: SQL): PromiseLike<Results<Record<string, unknown>>>
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored waveform returned an invalid ${field}`)
  }
  return value
}

function byteField(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error("Stored waveform returned invalid peak data")
}

export async function readWaveformWindow(
  executor: WaveformExecutor,
  assetId: string,
  cacheVersion: number,
  startFrame: number,
  endFrame: number,
  maxBuckets: number
): Promise<StoredWaveformWindow | null> {
  const targetFramesPerBucket = Math.max(
    1,
    Math.ceil((endFrame - startFrame) / Math.max(1, maxBuckets))
  )
  const result = await executor.execute(sql`
    with selected as (
      select
        frames_per_bucket,
        bucket_count,
        channels,
        sample_rate,
        frame_count,
        peaks
      from asset_waveform_levels
      where asset_id = ${assetId}
        and cache_version = ${cacheVersion}
      order by
        case when frames_per_bucket <= ${targetFramesPerBucket} then 0 else 1 end,
        case
          when frames_per_bucket <= ${targetFramesPerBucket} then frames_per_bucket
        end desc,
        frames_per_bucket asc
      limit 1
    ),
    windowed as (
      select
        *,
        greatest(0::bigint, least(frame_count, ${startFrame}::bigint)) as clamped_start,
        greatest(
          greatest(0::bigint, least(frame_count, ${startFrame}::bigint)),
          least(frame_count, ${endFrame}::bigint)
        ) as clamped_end
      from selected
    ),
    bucketed as (
      select
        *,
        floor(clamped_start::numeric / frames_per_bucket)::bigint as first_bucket,
        least(
          bucket_count::bigint,
          ceil(clamped_end::numeric / frames_per_bucket)::bigint
        ) as last_bucket
      from windowed
    )
    select
      sample_rate,
      channels,
      frame_count,
      first_bucket * frames_per_bucket as start_frame,
      least(frame_count, last_bucket * frames_per_bucket) as end_frame,
      frames_per_bucket,
      (last_bucket - first_bucket)::integer as window_bucket_count,
      substring(
        peaks
        from (first_bucket * channels * 8 + 1)::integer
        for ((last_bucket - first_bucket) * channels * 8)::integer
      ) as window_peaks
    from bucketed
  `)
  const row = result.rows[0]
  if (!row) return null
  return {
    sampleRate: numberField(row, "sample_rate"),
    channels: numberField(row, "channels"),
    frameCount: numberField(row, "frame_count"),
    startFrame: numberField(row, "start_frame"),
    endFrame: numberField(row, "end_frame"),
    framesPerBucket: numberField(row, "frames_per_bucket"),
    bucketCount: numberField(row, "window_bucket_count"),
    peaks: byteField(row.window_peaks)
  }
}
