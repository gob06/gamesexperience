export type CarouselPhoto = { id: string; createdAt: string; approvedAt?: string | null }

export type CarouselState = {
  photos: CarouselPhoto[]
  currentId: string | null
  pendingIds: string[]
  showingNew: boolean
  initialized: boolean
  paused: boolean
}

export const initialCarouselState: CarouselState = {
  photos: [], currentId: null, pendingIds: [], showingNew: false, initialized: false, paused: false,
}

type CarouselAction =
  | { type: 'refresh'; photos: CarouselPhoto[]; paused: boolean }
  | { type: 'advance' }
  | { type: 'reset' }

export function selfieCarousel(state: CarouselState, action: CarouselAction): CarouselState {
  if (action.type === 'reset') return initialCarouselState
  if (action.type === 'advance') {
    if (state.paused || !state.photos.length) return state
    const [next, ...pendingIds] = state.pendingIds
    if (next) return { ...state, currentId: next, pendingIds, showingNew: true }
    const index = state.photos.findIndex((photo) => photo.id === state.currentId)
    return { ...state, currentId: state.photos[(index + 1) % state.photos.length].id, showingNew: false }
  }

  const photos = [...action.photos].sort((a, b) =>
    (a.approvedAt || a.createdAt).localeCompare(b.approvedAt || b.createdAt) || a.id.localeCompare(b.id),
  )
  const ids = new Set(photos.map((photo) => photo.id))
  const previousIds = new Set(state.photos.map((photo) => photo.id))
  const additions = state.initialized ? photos.filter((photo) => !previousIds.has(photo.id)).map((photo) => photo.id) : []
  let pendingIds = [...state.pendingIds.filter((id) => ids.has(id)), ...additions]
  let currentId = state.currentId && ids.has(state.currentId) ? state.currentId : null
  let showingNew = currentId ? state.showingNew : false

  if (!action.paused && pendingIds.length && (!currentId || !showingNew)) {
    currentId = pendingIds[0]
    pendingIds = pendingIds.slice(1)
    showingNew = true
  } else if (!currentId && photos.length) {
    currentId = photos[0].id
    pendingIds = pendingIds.filter((id) => id !== currentId)
    showingNew = false
  }
  return { photos, currentId, pendingIds, showingNew, initialized: true, paused: action.paused }
}
