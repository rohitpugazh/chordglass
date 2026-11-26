// A live copy of the glasses display on the phone/laptop page, so the app can
// be developed and checked without glasses or the simulator.

import type { Page, PreviewSink } from '../glasses/screen'

export class DomPreview implements PreviewSink {
  private readonly root: HTMLElement
  private boxes = new Map<string, HTMLElement>()
  private layout = ''

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'g2-screen'
    container.appendChild(this.root)
  }

  show(page: Page, imageData: Map<string, string>) {
    if (page.layout !== this.layout) {
      this.root.replaceChildren()
      this.boxes.clear()
      this.layout = page.layout
    }
    for (const t of page.texts) {
      if (t.capture && t.content.trim() === '') continue
      const el = this.box(t.name, t.x, t.y, t.w, t.h, 'g2-text')
      if (el.textContent !== t.content) el.textContent = t.content
    }
    for (const b of page.images) {
      const el = this.box(b.name, b.x, b.y, b.w, b.h, 'g2-image')
      const src = `data:image/png;base64,${imageData.get(b.name) ?? ''}`
      let img = el.querySelector('img')
      if (!img) { img = document.createElement('img'); el.appendChild(img) }
      if (img.getAttribute('src') !== src) img.setAttribute('src', src)
    }
  }

  private box(name: string, x: number, y: number, w: number, h: number, cls: string): HTMLElement {
    let el = this.boxes.get(name)
    if (!el) {
      el = document.createElement('div')
      el.className = cls
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
      this.root.appendChild(el)
      this.boxes.set(name, el)
    }
    return el
  }
}
