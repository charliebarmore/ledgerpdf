/** Find a nearby clear square for a mark, in displayed page coordinates. */
export function besideText(
  hit: { box: readonly number[]; ny: number },
  words: readonly { box: readonly number[] }[],
  page: { w: number; h: number },
  size: number
): number | null {
  const halfX = size / (2 * page.w)
  const halfY = size / (2 * page.h)
  const gap = 2 / page.w
  const top = hit.ny - halfY
  const bottom = hit.ny + halfY
  if (top < 0 || bottom > 1) return null
  let left = hit.box[2] + gap
  const limit = hit.box[2] + (size + 16) / page.w
  // A slightly longer amount on the adjacent row may intrude into a tall
  // mark. Move past it, but never silently jump across a wide table column.
  for (let attempt = 0; attempt < 16; attempt++) {
    const right = left + 2 * halfX
    if (right > 1 || left > limit) return null
    const collisions = words.filter(({ box }) =>
      box[0] < right + gap && box[2] > left - gap / 2 && box[1] < bottom && box[3] > top
    )
    if (!collisions.length) return Number((left + halfX).toFixed(5))
    left = Math.max(...collisions.map(({ box }) => box[2])) + gap
  }
  return null
}
