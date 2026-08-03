import type {
  CompiledAudioGraphEdge,
  CompiledAudioGraphNode,
  CompiledAudioGraphSnapshot
} from "@heron/contracts"

export interface PositionedCompiledGraphNode extends CompiledAudioGraphNode {
  x: number
  y: number
}

export interface CompiledEffectGraphLayout {
  nodes: PositionedCompiledGraphNode[]
  edges: CompiledAudioGraphEdge[]
}

export function layoutCompiledEffectGraph(
  snapshot: CompiledAudioGraphSnapshot
): CompiledEffectGraphLayout {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(snapshot.nodes.map((node) => [node.id, 0]))
  for (const edge of snapshot.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const level = new Map<string, number>()
  const queue = snapshot.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort()
  for (const id of queue) level.set(id, 0)
  while (queue.length > 0) {
    const id = queue.shift()!
    const sourceLevel = level.get(id) ?? 0
    for (const target of [...(outgoing.get(id) ?? [])].sort()) {
      level.set(target, Math.max(level.get(target) ?? 0, sourceLevel + 1))
      const remaining = (indegree.get(target) ?? 1) - 1
      indegree.set(target, remaining)
      if (remaining === 0) {
        queue.push(target)
        queue.sort()
      }
    }
  }

  const fallbackLevel = Math.max(0, ...level.values()) + 1
  const groups = new Map<number, CompiledAudioGraphNode[]>()
  for (const node of snapshot.nodes) {
    const nodeLevel = level.get(node.id) ?? fallbackLevel
    groups.set(nodeLevel, [...(groups.get(nodeLevel) ?? []), node])
  }

  const nodes = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([nodeLevel, group]) =>
      group
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((node, index) => ({
          ...node,
          x: 90 + nodeLevel * 230,
          y: 70 + index * 92
        }))
    )
  return { nodes, edges: snapshot.edges }
}
