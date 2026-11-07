import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import santaUrl from './santa.glb?url'

export default function SantaOverlay({ canvasRef, onReady, onError, width, height }: {
  canvasRef: React.RefObject<HTMLCanvasElement>
  onReady: () => void
  onError: () => void
  width: number
  height: number
}) {
  const callbacks = useRef({ onReady, onError })
  callbacks.current = { onReady, onError }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let active = true
    let frame = 0
    let model: THREE.Object3D | null = null
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
      renderer.setSize(512, 1024, false)
      renderer.setClearColor(0x000000, 0)
    } catch {
      callbacks.current.onError()
      return
    }

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-0.65, 0.65, 1.3, -1.3, 0.01, 100)
    camera.position.set(0, 0, 5)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 2.2))
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.set(2, 4, 5)
    scene.add(light)
    const pivot = new THREE.Group()
    scene.add(pivot)

    new GLTFLoader().load(santaUrl, (gltf) => {
      model = gltf.scene
      if (!active) {
        disposeModel(model)
        return
      }
      const bounds = new THREE.Box3().setFromObject(model)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      model.position.sub(center)
      const scale = Math.min(2.35 / size.y, 1.15 / size.x)
      pivot.scale.setScalar(scale)
      pivot.add(model)
      const start = performance.now()
      const render = (time: number) => {
        if (!active) return
        pivot.rotation.y = Math.sin((time - start) / 1400) * 0.16
        pivot.position.y = Math.sin((time - start) / 900) * 0.025
        renderer.render(scene, camera)
        frame = requestAnimationFrame(render)
      }
      render(start)
      callbacks.current.onReady()
    }, undefined, () => { if (active) callbacks.current.onError() })

    const lost = () => callbacks.current.onError()
    canvas.addEventListener('webglcontextlost', lost)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      canvas.removeEventListener('webglcontextlost', lost)
      if (model) disposeModel(model)
      renderer.dispose()
    }
  }, [canvasRef])

  return <canvas ref={canvasRef} className="selfie-santa" aria-label="Animated 3D Santa" role="img" style={{ width: `${width * 100}%`, height: `${height * 100}%` }} />
}

function disposeModel(model: THREE.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    materials.forEach((material) => material.dispose())
  })
}
