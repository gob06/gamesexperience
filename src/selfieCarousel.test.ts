import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { initialCarouselState, selfieCarousel, type CarouselPhoto } from './selfieCarousel.ts'

const photo = (id: string, time: string): CarouselPhoto => ({ id, createdAt: time, approvedAt: time })
const a = photo('a', '2026-01-01T00:00:01.000Z')
const b = photo('b', '2026-01-01T00:00:02.000Z')
const c = photo('c', '2026-01-01T00:00:03.000Z')
const d = photo('d', '2026-01-01T00:00:04.000Z')

test('new approvals interrupt rotation and each gets a turn', () => {
  let state = selfieCarousel(initialCarouselState, { type: 'refresh', photos: [b, a], paused: false })
  assert.equal(state.currentId, 'a')
  state = selfieCarousel(state, { type: 'advance' })
  assert.equal(state.currentId, 'b')
  state = selfieCarousel(state, { type: 'refresh', photos: [d, a, c, b], paused: false })
  assert.equal(state.currentId, 'c')
  assert.deepEqual(state.pendingIds, ['d'])
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b, c, d], paused: false })
  assert.equal(state.currentId, 'c')
  state = selfieCarousel(state, { type: 'advance' })
  assert.equal(state.currentId, 'd')
  state = selfieCarousel(state, { type: 'advance' })
  assert.equal(state.currentId, 'a')
})

test('paused rotation waits for new approvals and drops deleted photos', () => {
  let state = selfieCarousel(initialCarouselState, { type: 'refresh', photos: [a, b], paused: false })
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b, c, d], paused: true })
  assert.equal(state.currentId, 'a')
  assert.deepEqual(state.pendingIds, ['c', 'd'])
  assert.equal(selfieCarousel(state, { type: 'advance' }).currentId, 'a')
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b, d], paused: false })
  assert.equal(state.currentId, 'd')
  assert.deepEqual(state.pendingIds, [])
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b], paused: false })
  assert.equal(state.currentId, 'a')
})

test('new arrivals while a priority photo is displayed wait for its turn', () => {
  let state = selfieCarousel(initialCarouselState, { type: 'refresh', photos: [a], paused: false })
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b], paused: false })
  state = selfieCarousel(state, { type: 'refresh', photos: [a, b, c], paused: false })
  assert.equal(state.currentId, 'b')
  assert.deepEqual(state.pendingIds, ['c'])
  state = selfieCarousel(state, { type: 'advance' })
  assert.equal(state.currentId, 'c')
})
